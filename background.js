/**
 * EdgeBetter —— MV3 Service Worker
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
 *  - 改为在请求发出后、提交前取消导航：当前标签被导航到 pageX#edgebetter
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
import { decideAction } from './lib/decision.js';
import { planPrefixUpdates, countPrefixed } from './lib/plan.js';
import { findPendingByUrl } from './lib/pending.js';

const NAV_RE = /^https?:\/\/newtab@/i;
/** 取消 pending 导航用的固定 fragment（同文档导航的差异点） */
const RESTORE_FRAGMENT = '#edgebetter';
/** 待处理书签的兜底超时：超过它一律加前缀（此时气泡不可能还开着） */
const PENDING_MAX_MS = 30_000;
const PENDING_KEY = 'pendingPrefixes';

/** tabId -> 最近一次提交的 URL（tabs.onUpdated 维护） */
const tabUrls = new Map();
/** 为书签导航而新建的标签页（中键 / Ctrl 点击书签） */
const createdForBookmark = new Set();
/** 新建书签 id -> { url, at, tabId, timer }（等收藏气泡关闭后再加前缀） */
const pendingPrefix = new Map();

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

/* ---------------- 书签改写（存量） ---------------- */
async function applyBookmarkMode(mode) {
  const tree = await chrome.bookmarks.getTree();
  const ops = planPrefixUpdates(tree, mode);
  for (const op of ops) {
    try {
      await chrome.bookmarks.update(op.id, { url: op.to });
    } catch (e) {
      console.warn('[EdgeBetter] 书签更新失败', op.id, e);
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
    console.warn('[EdgeBetter] 书签更新失败', id, e);
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
  if (changeInfo.url) tabUrls.set(tabId, changeInfo.url);
});

chrome.tabs.onCreated.addListener((tab) => {
  tabUrls.set(tab.id, tab.url || tab.pendingUrl || '');
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

/**
 * 一次书签导航的落点处理。
 * @param {number} tabId 当前标签页
 * @param {string} target 书签真正的目标 URL（已去前缀）
 * @param {boolean} created 该标签页是否是为这次书签导航新建的
 */
async function openBookmark(tabId, target, created) {
  let prevUrl = tabUrls.get(tabId);
  if (prevUrl === undefined) {
    // 地图里没有（如浏览器刚启动）：直接问 tabs API 拿提交中的 URL
    try {
      prevUrl = (await chrome.tabs.get(tabId)).url;
    } catch {
      return; // 标签页可能已关闭
    }
  }
  const action = settings.overrideBlankTab
    ? decideAction({ prevUrl, createdForBookmark: created, extraBlankPatterns: settings.extraBlankPatterns })
    : 'create-restore';

  if (action === 'override') {
    // 覆盖当前（空白 / 为书签新建的）标签页——tabs.update 会取消 pending 导航
    await chrome.tabs.update(tabId, { url: target });
    return;
  }

  // ⚠ 顺序至关重要：必须"先取消导航，再开新标签"。
  // newtab@ 导航在 onBeforeNavigate 之后 20~50ms 就可能提交（站点秒回时），
  // 而 tabs.create 要走完"创建标签页"整条流程（几十到几百毫秒）。若先 await
  // tabs.create，等轮到取消时导航已经提交，取消就退化成"把标签导航回原页"
  // ——那就是用户看到的整页刷新。
  // 取消手法：导航到"原 URL + 固定 fragment"。与原页只差 fragment = 同文档
  // 导航：页面不卸载、不刷新、DOM 状态完整保留。
  const base = prevUrl ? prevUrl.split('#')[0] : '';
  let frag = null;
  if (base) {
    frag = RESTORE_FRAGMENT;
    if (base + frag === prevUrl) frag = RESTORE_FRAGMENT + '2'; // 极端碰撞兜底
  }
  // 两个操作同时下发：取消（第一个 IPC）→ 开新标签（第二个 IPC）
  const restore = frag ? chrome.tabs.update(tabId, { url: base + frag }) : null;
  const open = chrome.tabs.create({ url: target, active: true, openerTabId: tabId });
  await Promise.allSettled([restore, open].filter(Boolean));
  if (frag) await cleanupFragment(tabId, frag, prevUrl);
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
  try {
    await openBookmark(details.tabId, target, created);
    // 用户在待处理窗口里点了这个新书签：此刻气泡必然已关，可以安全加前缀
    if (pendingId) applyPending(pendingId);
  } catch (e) {
    console.warn('[EdgeBetter] 打开书签失败', e);
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
 * SW 被回收重启后 tabUrls 是空的。启动即补种一遍，避免重启后第一次书签导航
 * 还要 await chrome.tabs.get 才能拿到 prevUrl——那点延迟足以输掉取消竞态，
 * 结果就是当前页被整页重载。与 loadSettings 并行，不阻塞事件监听。
 */
async function seedTabUrls() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) tabUrls.set(t.id, t.url || t.pendingUrl || '');
    }
  } catch {
    /* 忽略：拿不到就退回 tabs.get 兜底 */
  }
}

seedTabUrls();
loadSettings().then(() => {
  refreshStats();
});
