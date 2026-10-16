/**
 * EdgeBetter —— MV3 Service Worker
 *
 * 职责：
 *  1. 书签 URL 加/去 newtab@ 前缀（开关，全部可逆）
 *  2. DNR 动态规则拦截 newtab@ 前缀的主框架导航，重定向到 open.html
 *  3. webNavigation.onBeforeNavigate 捕获待处理导航（目标 URL + 前页 URL + 落点决策）
 *  4. open.html 询问落点：
 *     - 空白新标签页（或该标签本就是为书签新建的）→ tabs.update 覆盖当前标签
 *     - 否则 → tabs.create 新建标签打开书签，open.html 再 history.back() 恢复原页面
 */
import { isPrefixed, isRewriteable, addPrefix, removePrefix } from './lib/bookmark-url.js';
import { decideAction } from './lib/decision.js';
import { planPrefixUpdates, countPrefixed } from './lib/plan.js';

const DNR_RULE_ID = 1001;
const NAV_RE = /^https?:\/\/newtab@/i;
const PENDING_TTL = 15000; // 待处理导航 15s 过期，防止内存泄漏

/** tabId -> 最近一次提交的 URL（tabs.onUpdated 维护） */
const tabUrls = new Map();
/** tabId -> { target, prevUrl, action, t } */
const pendingNav = new Map();
/** 为书签导航而新建的标签页（中键 / Ctrl 点击书签） */
const createdForBookmark = new Set();

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

/* ---------------- DNR 规则 ---------------- */
async function setDnrRule(on) {
  try {
    if (on) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [DNR_RULE_ID],
        addRules: [{
          id: DNR_RULE_ID,
          priority: 1,
          action: { type: 'redirect', redirect: { extensionPath: '/open.html' } },
          condition: { regexFilter: '^https?://newtab@', resourceTypes: ['main_frame'] },
        }],
      });
    } else {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [DNR_RULE_ID] });
    }
  } catch (e) {
    console.warn('[EdgeBetter] DNR 规则更新失败', e);
  }
}

/* ---------------- 书签改写 ---------------- */
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
  await setDnrRule(enabled);
  const n = await applyBookmarkMode(enabled ? 'enable' : 'disable');
  await refreshStats();
  return n;
}

// 新书签自动加前缀；用户手动去掉前缀则视为"豁免该书签"，不自动补回
chrome.bookmarks.onCreated.addListener((id, node) => {
  if (!settings.enabled || !node || !node.url) return;
  if (isPrefixed(node.url) || !isRewriteable(node.url)) return;
  chrome.bookmarks.update(id, { url: addPrefix(node.url) }).catch(() => {});
});

/* ---------------- 标签页状态跟踪 ---------------- */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) tabUrls.set(tabId, changeInfo.url);
});

chrome.tabs.onCreated.addListener((tab) => {
  tabUrls.set(tab.id, tab.url || tab.pendingUrl || '');
  // 中键 / Ctrl 点击书签：新标签直接带着 newtab@ 地址出生
  if (tab.pendingUrl && NAV_RE.test(tab.pendingUrl)) createdForBookmark.add(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabUrls.delete(tabId);
  pendingNav.delete(tabId);
  createdForBookmark.delete(tabId);
});

function sweepPending(now) {
  for (const [id, nav] of pendingNav) {
    if (now - nav.t > PENDING_TTL) pendingNav.delete(id);
  }
}

/* ---------------- 拦截 newtab@ 导航 ---------------- */
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0 || !NAV_RE.test(details.url)) return;
  const now = Date.now();
  sweepPending(now);
  const created = createdForBookmark.has(details.tabId);
  createdForBookmark.delete(details.tabId);
  let prevUrl = tabUrls.get(details.tabId);
  if (prevUrl === undefined) {
    // 地图里没有（如浏览器刚启动）：直接问 tabs API 拿提交中的 URL
    try {
      prevUrl = (await chrome.tabs.get(details.tabId)).url;
    } catch {
      /* 标签页可能已关闭 */
    }
  }
  const action = settings.overrideBlankTab
    ? decideAction({ prevUrl, createdForBookmark: created, extraBlankPatterns: settings.extraBlankPatterns })
    : 'create-restore';
  pendingNav.set(details.tabId, { target: removePrefix(details.url), prevUrl, action, t: now });
});

/* ---------------- open.html 询问落点 ---------------- */
async function handleOpenBookmark(tabId) {
  const nav = pendingNav.get(tabId);
  if (!nav) return null;
  pendingNav.delete(tabId);
  try {
    if (nav.action === 'override') {
      // 覆盖当前（空白）标签页
      await chrome.tabs.update(tabId, { url: nav.target });
    } else {
      // 新建标签打开书签；open.html 收到响应后 history.back() 恢复原页面
      await chrome.tabs.create({ url: nav.target, active: true, openerTabId: tabId });
    }
    return nav.action;
  } catch (e) {
    console.warn('[EdgeBetter] 打开书签失败', e);
    return null;
  }
}

async function getState() {
  const { stats } = await chrome.storage.local.get('stats');
  return { ...settings, stats: stats || null };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'openBookmark') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ action: null });
      return;
    }
    handleOpenBookmark(tabId)
      .then((action) => sendResponse({ action }))
      .catch(() => sendResponse({ action: null }));
    return true; // 异步响应
  }
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
    await setDnrRule(settings.enabled);
    await refreshStats();
  }
});

loadSettings().then(() => {
  setDnrRule(settings.enabled);
  refreshStats();
});
