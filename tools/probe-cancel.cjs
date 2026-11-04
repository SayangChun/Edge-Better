/**
 * Edge Better —— 「取消 pending 导航」写法对照实验
 *
 * 背景：点书签时浏览器已经把当前标签导航到 https://newtab@target，扩展只能事后取消。
 * 现有写法是 tabs.update 到「原 URL + #edge-better」（同文档 fragment 导航），
 * 但实测它会触发 popstate + hashchange —— SPA 直播站会因此重渲染/暂停播放器。
 *
 * 本探针比较几种取消写法的副作用：
 *   same    原 URL 完全相同
 *   empty   原 URL + "#"（空 fragment，location.hash 仍为空）
 *   frag    原 URL + "#edge-better"（现有写法）
 *   back    chrome.tabs.goBack()
 *
 * 判据：
 *   - pending 导航有没有被取消（/target 有没有被请求、原页 docId 有没有变）
 *   - 原页收到了哪些事件（beforeunload / popstate / hashchange / pagehide）
 *
 * 扩展以 enabled=false 加载，避免它自己的逻辑干扰；由探针在 onBeforeNavigate
 * 里复刻「收到事件 → 立刻 tabs.update」的时序。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8919;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV = (p) => `http://newtab@127.0.0.1:${PORT}${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = (title) => `<!doctype html><html><head><title>${title}</title></head>
<body style="height:3000px"><h1>${title}</h1>
<script>
window.__docId = Math.random().toString(36).slice(2);
window.__events = [];
function rec(type, extra) {
  window.__events.push(Object.assign({ type: type, t: Math.round(performance.now()), hash: location.hash, href: location.href }, extra || {}));
}
window.addEventListener('beforeunload', function () { rec('beforeunload'); });
window.addEventListener('pagehide', function (e) { rec('pagehide', { persisted: e.persisted }); });
window.addEventListener('pageshow', function (e) { rec('pageshow', { persisted: e.persisted }); });
window.addEventListener('popstate', function (e) { rec('popstate', { state: JSON.stringify(e.state) }); });
window.addEventListener('hashchange', function (e) { rec('hashchange', { from: e.oldURL, to: e.newURL }); });
document.addEventListener('visibilitychange', function () { rec('visibilitychange'); });
rec('load');
</script></body></html>`;

async function main() {
  const hits = { target: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, BASE);
    if (u.pathname === '/target') hits.target++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE('PAGE ' + u.pathname));
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-cancel-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: true,
    args: [
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
    ],
    viewport: null,
  });

  const getSw = async () => {
    for (let i = 0; i < 60; i++) {
      const sws = context.serviceWorkers();
      if (sws.length) return sws[sws.length - 1];
      await sleep(200);
    }
    throw new Error('SW 未找到');
  };

  try {
    const sw = await getSw();
    const extId = new URL(sw.url()).host;
    await sleep(1200);

    const existing = new Set(context.pages());
    const bcdp = await context.browser().newBrowserCDPSession();
    await bcdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    let popup = null;
    for (let i = 0; i < 50; i++) {
      const fresh = context.pages().filter((p) => !existing.has(p));
      if (fresh.length) { popup = fresh[0]; break; }
      await sleep(200);
    }
    if (!popup) throw new Error('popup 页未出现');
    await sleep(600);
    // 关掉扩展自己的拦截逻辑，本探针自己复刻时序
    await popup.evaluate(() => chrome.storage.local.set({ enabled: false }));
    await sleep(300);

    // 在 popup 里装"取消器"：收到 newtab@ 的 onBeforeNavigate 就按指定写法取消
    await popup.evaluate(() => {
      window.__cancelLog = [];
      chrome.webNavigation.onBeforeNavigate.addListener((d) => {
        if (d.frameId !== 0 || !/newtab@/.test(d.url)) return;
        const mode = window.__mode;
        const prev = window.__prevUrl;
        const t0 = performance.now();
        const log = (what, extra) => window.__cancelLog.push({ what, dt: Math.round(performance.now() - t0), extra: extra || '' });
        log('beforeNavigate', d.url);
        try {
          if (mode === 'same') {
            chrome.tabs.update(d.tabId, { url: prev }).then(
              (t) => log('update ok', t.url), (e) => log('update err', String(e)));
          } else if (mode === 'empty') {
            chrome.tabs.update(d.tabId, { url: prev + '#' }).then(
              (t) => log('update ok', t.url), (e) => log('update err', String(e)));
          } else if (mode === 'frag') {
            chrome.tabs.update(d.tabId, { url: prev + '#edge-better' }).then(
              (t) => log('update ok', t.url), (e) => log('update err', String(e)));
          } else if (mode === 'back') {
            chrome.tabs.goBack(d.tabId).then(
              () => log('goBack ok'), (e) => log('goBack err', String(e)));
          }
        } catch (e) {
          log('throw', String(e));
        }
      });
    });

    const page = await context.newPage();

    const scenario = async (mode) => {
      await page.goto(BASE + '/live', { waitUntil: 'load' });
      await sleep(600);
      const before = await page.evaluate(() => ({ docId: window.__docId, url: location.href }));
      const tBefore = hits.target;
      const tabId = await popup.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => (x.url || '').endsWith('/live'));
        return t ? t.id : null;
      });
      await popup.evaluate(({ id, prev, m }) => {
        window.__mode = m;
        window.__prevUrl = prev;
        window.__cancelLog = [];
        return chrome.tabs.update(id, { url: `http://newtab@127.0.0.1:8919/target`, active: true });
      }, { id: tabId, prev: BASE + '/live', m: mode });

      await sleep(2000);
      const after = await page.evaluate(() => ({
        docId: window.__docId, url: location.href, events: window.__events,
      })).catch((e) => ({ error: String(e).slice(0, 120) }));
      const clog = await popup.evaluate(() => window.__cancelLog);
      const tabs = await popup.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url }))));

      console.log(`\n===== 写法: ${mode} =====`);
      console.log('  取消器日志:', JSON.stringify(clog));
      console.log('  原页 before:', JSON.stringify(before));
      console.log('  原页 after :', after.error ? after.error : JSON.stringify({ docId: after.docId, url: after.url }));
      console.log('  /target 请求数:', hits.target - tBefore);
      console.log('  标签页:', JSON.stringify(tabs));
      if (!after.error) {
        console.log('  事件:', JSON.stringify(after.events.filter((e) => e.type !== 'load')));
      }
      const reloaded = !after.error && after.docId !== before.docId;
      const canceled = hits.target === tBefore && !reloaded;
      const bad = !after.error ? after.events.filter((e) => ['beforeunload', 'popstate', 'hashchange', 'pagehide'].includes(e.type)) : [];
      console.log(`  → 取消${canceled ? '成功' : '失败'}；原页${reloaded ? '被重建' : '保留'}；副作用事件 ${bad.length} 个` +
        (bad.length ? `: ${bad.map((e) => e.type).join(',')}` : ''));
    };

    for (const m of (process.env.MODES || 'same,empty,frag,back').split(',')) {
      await scenario(m.trim());
    }
  } finally {
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
