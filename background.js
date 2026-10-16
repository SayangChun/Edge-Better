/**
 * Edge Better —— MV3 Service Worker
 *
 * 职责：
 *  1. 书签 URL 加/去 newtab@ 前缀（开关，全部可逆）
 *  2. webNavigation.onBeforeNavigate 捕获书签导航，直接开标签：
 *     - 空白新标签页（或该标签本就是为这次书签导航新建的——中键 / Ctrl 点击）
 *       → tabs.update 覆盖当前标签页
 *     - 否则 → tabs.create 新建标签打开书签，同时把当前标签导航到
 *       "原 URL + 固定 fragment"——与原页只差 fragment 的同文档导航，
 *       **当前页不卸载、不刷新、DOM 状态完整保留**（用户诉求）
 *  3. 新建书签的加前缀**延后**到收藏气泡关闭之后（见下）
 *
 * 为什么取消导航要抢在 tabs.create 之前：
 *  - newtab@ 导航在 onBeforeNavigate 之后 20~50ms 就可能提交（站点秒回时），
 *    而 tabs.create 要走完"创建标签页"整条流程（几十到几百毫秒）。先 await
 *    tabs.create 的话，等轮到取消时导航已提交，取消就退化成"导航回原页"
 *    ——那就是用户看到的整页刷新。
 *  - 改为在请求发出后、提交前取消导航：当前标签被导航到 pageX#edge-better
 *    （同文档），原页从未离开。若竞态仍失败（SW 刚被唤醒、事件送达太晚），
 *    tabs.update 会把标签导航回原页——退化为一次重载，与旧版行为一致。
 *
 * 为什么新建书签不能立刻加前缀（用户报告的 bug）：
 *  - Edge 点星标会**立即**在默认文件夹建好书签并弹出收藏气泡，用户随后在气泡里
 *    挑文件夹。实测确认：此刻对节点的任何外部改写都会打乱这次编辑，结果用户选的
 *    文件夹被丢回最初那个（"即使选择了其他文件夹，还是保存在最初显示的文件夹里"）。
 *  - 所以把加前缀推迟到"气泡必然已关闭"的时刻：用户切标签 / 关掉那个标签 /
 *    那个标签导航走 / 浏览器窗口彻底失焦 / 浏览器重启 / 兜底 30s。
 *  - 待处理窗口里书签还没有前缀，点它不会走 newtab@ 通道；因此额外识别
 *    "导航到某个待处理书签的 URL"，走同一套落点逻辑（地址栏手输的不算）。
 */
import { isPrefixed, isRewriteable, addPrefix, removePrefix } from './lib/bookmark-url.js';
import { decideAction, navState } from './lib/decision.js';
import { planPrefixUpdates, countPrefixed } from './lib/plan.js';
import { findPendingByUrl } from './lib/pending.js';

const NAV_RE = /^https?:\/\/newtab@/i;
/** 取消 pending 导航用的固定 fragment（同文档导航的差异点） */
const RESTORE_FRAGMENT = '#edge-better';
/** 待处理书签的兜底超时：超过它一律加前缀（此时气泡不可能还开着） */
const PENDING_MAX_MS = 30_000;
const PENDING_KEY = 'pendingPrefixes';
/** tabId -> URL 的持久化副本（SW 被回收重启后 tabUrls 会丢，冷启动就认不出原页） */
const TABURLS_KEY = 'tabUrls';
/** 保活闹钟名（30s 是 chrome.alarms 允许的最小周期，正好压住 SW 的 30s 空闲回收） */
const KEEPALIVE_ALARM = 'edge-better-keepalive';

/** tabId -> 最近一次提交的 URL（tabs.onUpdated 维护） */
const tabUrls = new Map();
/** 为书签导航而新建的标签页（中键 / Ctrl 点击书签） */
const createdForBookmark = new Set();
/** 新建书签 id -> { url, at, tabId, timer }（等收藏气泡关闭后再加前缀） */
const pendingPrefix = new Map();
let tabUrlsTimer = null;

let settings = { enabled: true, overrideBlankTab: true, extraBlankPatterns: [] };

/* ---------------- 设置 ---------------- */
async function loadSettings() {
  const stored = await chrome.storage.local.get(null);
  settings = {
    enabled: stored.enabled !== false,
    overrideBlankTab: stored.overrideBlankTab !== false,
    extraBlankPatterns: Array.isArray(stored.extraBlankPatterns) ? stored.extraBlankPatterns : [],
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, v] of Object.entries(changes)) {
    if (k in settings) settings[k] = v.newValue;
  }
});

/* ---------------- Service Worker 保活 ----------------
 * MV3 的 SW 空闲 30s 就被回收（官方文档：Chrome 118 起调试器会话会保活，所以
 * 挂着 DevTools/Playwright 时看不到这个问题）。而书签点击要求扩展在
 * 20~50ms 内把 pending 导航取消掉——冷启动唤醒要几十到几百毫秒，必然输掉竞态，
 * 当前页会被书签页顶掉。30s 周期的闹钟事件正好重置空闲计时器，让 SW 保持温热。
 * （成本：SW 常驻内存几 MB + 每 30s 一次空转。这是"当前页绝不刷新"的代价。）
 */
async function syncKeepAlive() {
  try {
    if (settings.enabled) {
      await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    } else {
      await chrome.alarms.clear(KEEPALIVE_ALARM);
    }
  } catch (e) {
    console.warn('[Edge Better] 保活闹钟设置失败', e);
  }
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // 空转即可：alarm 事件本身就会重置 SW 的 30s 空闲计时器
});

/* ---------------- tabUrls 持久化 ----------------
 * SW 被回收后内存里的 tabUrls 就没了，而"这次书签导航有没有已经提交"必须拿
 * 导航前的 URL 来对比。所以把 tabUrls 镜像进 storage.session（内存态，浏览器关掉才清），
 * 重启后先恢复再补种。写入防抖 300ms：上一次导航早就写完了，足够。
 */
function scheduleTabUrlsPersist() {
  if (tabUrlsTimer) return;
  tabUrlsTimer = setTimeout(async () => {
    tabUrlsTimer = null;
    try {
      await chrome.storage.session.set({ [TABURLS_KEY]: Object.fromEntries(tabUrls) });
    } catch {
      /* storage.session 不可用就退回内存表 */
    }
  }, 300);
}

async function restoreTabUrls() {
  try {
    const { [TABURLS_KEY]: saved } = await chrome.storage.session.get(TABURLS_KEY);
    if (!saved) return;
    for (const [id, url] of Object.entries(saved)) {
      const tid = Number(id);
      if (!tabUrls.has(tid)) tabUrls.set(tid, url);
    }
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 书签改写（存量） ---------------- */
async function applyBookmarkMode(mode) {
  const tree = await chrome.bookmarks.getTree();
  const ops = planPrefixUpdates(tree, mode);
  for (const op of ops) {
    try {
      await chrome.bookmarks.update(op.id, { url: op.to });
    } catch (e) {
      console.warn('[Edge Better] 书签更新失败', op.id, e);
    }
  }
  return ops.length;
}

async function refreshStats() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const c = countPrefixed(tree);
    await chrome.storage.local.set({ stats: { prefixedCount: c, lastScan: new Date().toISOString() } });
    return c;
  } catch {
    return 0;
  }
}

async function setEnabled(enabled) {
  settings.enabled = enabled;
  await chrome.storage.local.set({ enabled });
  const n = await applyBookmarkMode(enabled ? 'enable' : 'disable');
  if (!enabled) clearPending(); // 关闭时待处理项一并作废（书签已还原）
  await syncKeepAlive();
  await refreshStats();
  return n;
}

/* ---------------- 新建书签：延后加前缀 ---------------- */
function persistPending() {
  const obj = {};
  for (const [id, rec] of pendingPrefix) obj[id] = { url: rec.url, at: rec.at, tabId: rec.tabId };
  chrome.storage.local.set({ [PENDING_KEY]: obj }).catch(() => {});
}

function clearPending() {
  for (const rec of pendingPrefix.values()) clearTimeout(rec.timer);
  pendingPrefix.clear();
  chrome.storage.local.remove(PENDING_KEY).catch(() => {});
}

/** 重新装表：按记录里的创建时刻算剩余兜底时间（SW 回收重启后靠它续上） */
function armPending(id) {
  const rec = pendingPrefix.get(id);
  if (!rec) return;
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => applyPending(id), Math.max(0, rec.at + PENDING_MAX_MS - Date.now()));
}

async function loadPending() {
  try {
    const { [PENDING_KEY]: stored } = await chrome.storage.local.get(PENDING_KEY);
    if (!stored) return;
    for (const [id, rec] of Object.entries(stored)) {
      if (pendingPrefix.has(id)) continue;
      pendingPrefix.set(id, { url: rec.url, at: rec.at || Date.now(), tabId: rec.tabId, timer: null });
      armPending(id);
    }
  } catch {
    /* 读不到就当没有待处理项 */
  }
}
const pendingReady = loadPending();

/** 给一个待处理书签加前缀（先回读节点：用户可能刚在气泡里改过标题 / URL / 文件夹） */
async function applyPending(id) {
  const rec = pendingPrefix.get(id);
  if (!rec) return;
  clearTimeout(rec.timer);
  pendingPrefix.delete(id);
  persistPending();
  if (!settings.enabled) return;
  let node;
  try {
    [node] = await chrome.bookmarks.get(id);
  } catch {
    return; // 已被删除
  }
  if (!node || !node.url || isPrefixed(node.url) || !isRewriteable(node.url)) return;
  const target = addPrefix(node.url);
  if (!target) return;
  try {
    await chrome.bookmarks.update(id, { url: target });
  } catch (e) {
    console.warn('[Edge Better] 书签更新失败', id, e);
  }
}

/** 气泡必然已关闭 → 把所有待处理书签补上前缀 */
function flushPending() {
  for (const id of [...pendingPrefix.keys()]) applyPending(id);
}

/** 只补某个标签页创建的那些 */
function flushPendingForTab(tabId) {
  for (const [id, rec] of pendingPrefix) {
    if (rec.tabId === tabId) applyPending(id);
  }
}

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  if (!settings.enabled || !node || !node.url) return;
  if (isPrefixed(node.url) || !isRewriteable(node.url)) return;
  // 记住是哪个标签页创建的：那个标签页导航走 / 被关掉 = 气泡已关
  let tabId = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = t ? t.id : null;
  } catch {
    /* 拿不到就算了，兜底超时仍会补上 */
  }
  const rec = { url: node.url, at: Date.now(), tabId, timer: null };
  pendingPrefix.set(id, rec);
  armPending(id);
  persistPending();
});

// 用户在气泡里改了 URL / 标题 / 文件夹：只更新记录，绝不改写节点（改写会打断气泡）
chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  const rec = pendingPrefix.get(id);
  if (rec && changeInfo && changeInfo.url) {
    rec.url = changeInfo.url;
    persistPending();
  }
});
chrome.bookmarks.onRemoved.addListener((id) => {
  const rec = pendingPrefix.get(id);
  if (rec) {
    clearTimeout(rec.timer);
    pendingPrefix.delete(id);
    persistPending();
  }
});

/* ---------------- 气泡已关闭的信号 ---------------- */
// 切换标签：气泡一定已关
chrome.tabs.onActivated.addListener(() => flushPending());
// 关掉创建它的那个标签：气泡一定已关
chrome.tabs.onRemoved.addListener((tabId) => flushPendingForTab(tabId));
// 浏览器窗口彻底失焦（切到别的应用）：气泡一定已关
// 注意：气泡自身弹开时 windowId 会变成浏览器窗口 id（实测），所以只认 -1
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) flushPending();
});
// 浏览器重启：上一轮的气泡不可能还开着
chrome.runtime.onStartup.addListener(async () => {
  await pendingReady;
  flushPending();
});

/* ---------------- 标签页状态跟踪 ---------------- */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    tabUrls.set(tabId, changeInfo.url);
    scheduleTabUrlsPersist();
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  tabUrls.set(tab.id, tab.url || tab.pendingUrl || '');
  scheduleTabUrlsPersist();
  // 中键 / Ctrl 点击书签：新标签直接带着书签地址出生
  // （带前缀的走 NAV_RE；待处理窗口里还没前缀的走 pending 匹配）
  const pu = tab.pendingUrl;
  if (pu && (NAV_RE.test(pu) || findPendingByUrl(Object.fromEntries(pendingPrefix), pu))) {
    createdForBookmark.add(tab.id);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabUrls.delete(tabId);
  createdForBookmark.delete(tabId);
  scheduleTabUrlsPersist();
});

/* ---------------- 打开书签：新建标签 + 取消当前页导航 ---------------- */
/**
 * 清掉地址栏里用于取消导航的临时 fragment。
 * 同文档导航后 hash 应立即就位；重试几次兜住偶发的时序错位（脚本可能在
 * 文档尚未就绪时被注入）。页面自己改了 hash 时立即放弃，不覆盖页面状态。
 */
async function cleanupFragment(tabId, frag, original) {
  for (let i = 0; i < 5; i++) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (expectedHash, orig) => {
          if (location.hash !== expectedHash) return false;
          history.replaceState(null, '', orig); // 不触发导航、不影响星标
          return true;
        },
        args: [frag, original],
      });
      if (res && res.result) return;
    } catch {
      return; // 标签页已关闭 / 不可注入：留着 fragment 无害
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

/** SW 启动时刻：用来判断这次事件是不是"刚把 SW 唤醒"的那一次（冷启动赢不了竞态） */
const swStartedAt = Date.now();

/**
 * 监听这次书签导航有没有提交。**必须在任何 await 之前注册**——冷启动时导航往往在
 * SW 醒来之前就提交了，那个 onCommitted 事件正排在队列里，先注册才接得住。
 */
function watchCommit(tabId, target) {
  const state = { committed: false };
  const onCommitted = (d) => {
    if (d.tabId === tabId && d.frameId === 0 && (d.url === target || NAV_RE.test(d.url))) {
      state.committed = true;
    }
  };
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  state.stop = () => chrome.webNavigation.onCommitted.removeListener(onCommitted);
  return state;
}

/** 轮询等一个标志位（用于"等导航落定"） */
async function waitFlag(flag, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!flag() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
  return flag();
}

/**
 * 书签导航已经提交 → 当前页被书签页顶掉了。回退一步：原页在 bfcache 里，
 * 会被冻结-恢复，DOM / 滚动状态无损，而且**不是重载**（实测 pageshow persisted=true）。
 * ⚠ 绝不能改成 tabs.update 导航回原 URL——那是跨文档导航，会整页重载。
 */
async function restoreByGoingBack(tabId) {
  for (let i = 0; i < 5; i++) {
    try {
      await chrome.tabs.goBack(tabId);
      return true;
    } catch {
      // 提交瞬间历史可能还没落定（实测报 "Cannot find a next page in history"）
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    // 兜底：在页面里回退一步（同样是回退，同样走 bfcache）
    await chrome.scripting.executeScript({ target: { tabId }, func: () => history.back() });
    return true;
  } catch (e) {
    console.warn('[Edge Better] 回退恢复原页失败', e);
    return false;
  }
}

/**
 * 取消 pending 导航：导航到"原 URL + 固定 fragment"。
 * 与原页只差 fragment = 同文档导航：页面不卸载、不刷新、DOM 状态完整保留。
 * 调用它会**立刻发出 tabs.update**（async 函数体在第一个 await 之前是同步执行的），
 * 所以调用方要把它排在 tabs.create 前面。
 */
async function cancelPendingNav(tabId, prevUrl) {
  const base = prevUrl ? prevUrl.split('#')[0] : '';
  if (!base) return;
  let frag = RESTORE_FRAGMENT;
  if (base + frag === prevUrl) frag = RESTORE_FRAGMENT + '2'; // 极端碰撞兜底
  await chrome.tabs.update(tabId, { url: base + frag });
  await cleanupFragment(tabId, frag, prevUrl);
}

/**
 * 一次书签导航的落点处理。
 * @param {number} tabId 当前标签页
 * @param {string} target 书签真正的目标 URL（已去前缀）
 * @param {boolean} created 该标签页是否是为这次书签导航新建的
 * @param {string|undefined} prevUrlSnapshot 导航前的 URL（调用方在任何 await 之前同步取的快照）
 */
async function openBookmark(tabId, target, created, prevUrlSnapshot) {
  const watch = watchCommit(tabId, target);
  // 冷启动：SW 就是被这次导航唤醒的。newtab@ 导航 20~50ms 就提交了，
  // 而冷启动唤醒 + 第一次 IPC 要几十到上百毫秒 —— 竞态必输，只能事后补救。
  const cold = Date.now() - swStartedAt < 1500;

  if (!cold && prevUrlSnapshot !== undefined) {
    // ---- 热路径：零 await ----
    // 取消必须**立刻**进浏览器队列：浏览器提交一次导航要几十毫秒，期间它没空处理
    // 我们的 tabs.update；晚一点点，取消就会排到提交后面，退化成"整页重载"。
    // 所以这里不做任何 await（连 tabs.get 都不做），决策只用同步拿到的 prevUrl。
    const action = settings.overrideBlankTab
      ? decideAction({ prevUrl: prevUrlSnapshot, createdForBookmark: created, extraBlankPatterns: settings.extraBlankPatterns })
      : 'create-restore';
    watch.stop();
    if (action === 'override') {
      // 覆盖当前（空白 / 为书签新建的）标签页——tabs.update 会取消 pending 导航
      await chrome.tabs.update(tabId, { url: target });
      return;
    }
    const cancel = cancelPendingNav(tabId, prevUrlSnapshot); // 第一个 IPC：取消 pending 导航
    const open = chrome.tabs.create({ url: target, active: true, openerTabId: tabId });
    await Promise.allSettled([cancel, open]);
    return;
  }

  // ---- 冷路径（或拿不到导航前 URL）----
  // 拿不到 prevUrl，也没机会抢在提交之前 —— 只能等导航落定：
  // 提交了就回退一步让 bfcache 把原页冻结-恢复；没提交就同文档取消。
  // 先开新标签，用户立刻看到书签，这一等不影响他。
  let curUrl = '';
  try {
    const [tab] = await Promise.all([chrome.tabs.get(tabId), tabUrlsRestored.catch(() => {})]);
    curUrl = tab.url || '';
  } catch {
    watch.stop();
    return; // 标签页可能已关闭
  }
  let prevUrl = prevUrlSnapshot !== undefined ? prevUrlSnapshot : tabUrls.get(tabId);
  if (prevUrl === undefined) prevUrl = curUrl; // 连记录都没有：只能尽力而为

  const action = settings.overrideBlankTab
    ? decideAction({ prevUrl, createdForBookmark: created, extraBlankPatterns: settings.extraBlankPatterns })
    : 'create-restore';

  if (action === 'override') {
    watch.stop();
    // 竞态下这一页可能已经是目标页了，那就别再折腾一次加载
    if (curUrl !== target) await chrome.tabs.update(tabId, { url: target });
    return;
  }

  const open = chrome.tabs.create({ url: target, active: true, openerTabId: tabId });
  await waitFlag(() => watch.committed, 800);
  const hijacked = watch.committed || navState({ prevUrl, curUrl, target }) === 'hijacked';
  watch.stop();
  if (hijacked) await restoreByGoingBack(tabId);
  else await cancelPendingNav(tabId, prevUrl);
  await open;
}

/* ---------------- 处理书签导航 ---------------- */
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const prefixed = NAV_RE.test(details.url);
  let pendingId = null;
  if (!prefixed) {
    await pendingReady.catch(() => {});
    const pending = Object.fromEntries(pendingPrefix);
    pendingId = findPendingByUrl(pending, details.url);
    if (!pendingId) {
      // 创建书签的那个标签页导航走了 → 气泡已关，补上前缀
      flushPendingForTab(details.tabId);
      return;
    }
    // 地址栏手输同一 URL 不算"点书签"（否则会莫名其妙多开一个标签）
    if ((details.transitionQualifiers || []).includes('from_address_bar')) return;
  } else if (!settings.enabled) {
    return; // 关闭状态：放行，newtab@ URL 按原样加载（优雅降级）
  }

  const target = prefixed ? removePrefix(details.url) : details.url;
  const created = createdForBookmark.has(details.tabId);
  createdForBookmark.delete(details.tabId);
  // ⚠ 同步快照：此刻 tabUrls 里还是"导航前"的 URL（下一个事件才会刷成提交后的）
  const prevUrlSnapshot = tabUrls.get(details.tabId);
  try {
    await openBookmark(details.tabId, target, created, prevUrlSnapshot);
    // 用户在待处理窗口里点了这个新书签：此刻气泡必然已关，可以安全加前缀
    if (pendingId) applyPending(pendingId);
  } catch (e) {
    console.warn('[Edge Better] 打开书签失败', e);
  }
});

/* ---------------- 弹窗 / 选项页消息 ---------------- */
async function getState() {
  const { stats } = await chrome.storage.local.get('stats');
  return { ...settings, stats: stats || null };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'getState') {
    getState().then(sendResponse).catch(() => sendResponse({ error: 'getState failed' }));
    return true;
  }
  if (msg.type === 'setEnabled') {
    setEnabled(!!msg.value)
      .then(() => getState())
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'setEnabled failed' }));
    return true;
  }
  if (msg.type === 'saveSettings') {
    const patch = {};
    if (typeof msg.overrideBlankTab === 'boolean') patch.overrideBlankTab = msg.overrideBlankTab;
    if (Array.isArray(msg.extraBlankPatterns)) patch.extraBlankPatterns = msg.extraBlankPatterns;
    chrome.storage.local
      .set(patch)
      .then(() => getState())
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'saveSettings failed' }));
    return true;
  }
});

/* ---------------- 启动 ---------------- */
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();
  if (details.reason === 'install') {
    await setEnabled(true); // 首次安装默认开启，可在弹窗一键关闭
  } else {
    await refreshStats();
  }
});

/**
 * SW 被回收重启后 tabUrls 是空的。启动时先用 storage.session 里的副本恢复
 * （那是**导航前**的 URL，冷启动判断"这次导航有没有提交"全靠它），再用 tabs.query
 * 补上副本里没有的标签页——已有记录不覆盖，免得把"导航前的 URL"冲成提交后的 URL。
 */
async function seedTabUrls() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null && !tabUrls.has(t.id)) tabUrls.set(t.id, t.url || t.pendingUrl || '');
    }
    scheduleTabUrlsPersist();
  } catch {
    /* 忽略：拿不到就退回 tabs.get 兜底 */
  }
}

/**
 * SW 启动时从 storage.session 恢复 tabUrls（见上）。书签导航处理前只等这个
 * ——它只是读内存态，1~3ms。tabs.query 补种放后台跑：那要几十毫秒，
 * 放在快路径前面会把"取消导航"拖到提交之后，反而制造出整页重载。
 */
const tabUrlsRestored = restoreTabUrls();
tabUrlsRestored.then(seedTabUrls);

loadSettings().then(() => {
  syncKeepAlive();
  refreshStats();
});
