/**
 * Edge Better —— 「直播页被点书签打断」复现探针
 *
 * 用户报告：看直播时点书签栏，新标签正常打开，但原直播页会暂停。
 *
 * 本探针用一个**真的在播放媒体的页面**（canvas.captureStream -> <video>）模拟直播页，
 * 记录点书签前后原页收到的全部相关事件，以及媒体播放是否连续：
 *   - docId 变没变（文档是否被卸载重建 = 整页重载）
 *   - hashchange / popstate / visibilitychange / pagehide / pageshow / freeze
 *   - video.paused、currentTime 是否连续
 *   - history.length、history.state 有没有被污染
 *
 * 场景：
 *   A 无 hash 的原页（B 站/Twitch/YouTube 这类）
 *   B 带 hash 路由的原页（SPA hash 路由，如 #/room/123）
 *   C 原页自己也在用 history.state（SPA 常态）
 *
 * 运行：
 *   NODE_PATH="C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/workspace/node_modules" \
 *     "C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe" \
 *     tools/probe-live-pause.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV = (p) => `http://newtab@127.0.0.1:${PORT}${p}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 服务器响应延迟：真实网站有网络延迟，取消导航才有窗口。DELAY=0 可复现极端竞态 */
const DELAY = Number(process.env.DELAY ?? 120);
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '\n        ' + extra : ''}`);
}

/**
 * 模拟直播页。带一个真实在播放的 <video>（canvas 流），
 * 并把所有可能"打断播放"的事件记进 __events。
 */
const PAGE = (title, opts = {}) => `<!doctype html><html><head><title>${title}</title>
<style>body{margin:0;height:3000px;background:#111;color:#eee;font:14px sans-serif}</style></head>
<body><h1>${title}</h1>
<canvas id="c" width="320" height="180" style="width:320px;height:180px"></canvas>
<video id="v" muted playsinline style="width:320px;height:180px"></video>
<script>
window.__docId = Math.random().toString(36).slice(2);
window.__events = [];
window.__ticks = 0;
function rec(type, extra) {
  window.__events.push(Object.assign({
    type: type,
    t: Math.round(performance.now()),
    hash: location.hash,
    href: location.href,
    vis: document.visibilityState,
    histLen: history.length,
    paused: document.getElementById('v') ? document.getElementById('v').paused : null,
  }, extra || {}));
}
window.addEventListener('hashchange', function (e) { rec('hashchange', { from: e.oldURL, to: e.newURL }); });
window.addEventListener('popstate', function (e) { rec('popstate', { state: JSON.stringify(e.state) }); });
document.addEventListener('visibilitychange', function () { rec('visibilitychange'); });
window.addEventListener('pagehide', function (e) { rec('pagehide', { persisted: e.persisted }); });
window.addEventListener('pageshow', function (e) { rec('pageshow', { persisted: e.persisted }); });
document.addEventListener('freeze', function () { rec('freeze'); });
document.addEventListener('resume', function () { rec('resume'); });
window.addEventListener('beforeunload', function () { rec('beforeunload'); });

var c = document.getElementById('c');
var ctx = c.getContext('2d');
var f = 0;
setInterval(function () {
  f++;
  ctx.fillStyle = 'hsl(' + (f * 7 % 360) + ',70%,45%)';
  ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = '#fff';
  ctx.fillText('frame ' + f, 10, 20);
  window.__ticks++;
}, 50);

var v = document.getElementById('v');
try {
  v.srcObject = c.captureStream(20);
  v.play().then(function () { rec('playing'); }).catch(function (err) { rec('playfail', { msg: String(err) }); });
} catch (err) { rec('streamfail', { msg: String(err) }); }

${opts.state ? `history.replaceState({ route: ${JSON.stringify(opts.state)} }, '', location.href);` : ''}

// 模拟 hash 路由 SPA：hash 一旦偏离预期路由就"下播"（真实 SPA 的常见后果）
${opts.hashRoute ? `
window.addEventListener('hashchange', function () {
  rec('spa-route', { route: location.hash });
  if (location.hash !== ${JSON.stringify(opts.hashRoute)}) {
    window.__routeBroken = location.hash;
    v.pause();
    rec('video-paused-by-router');
  }
});
` : ''}

rec('load');
</script></body></html>`;

async function main() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, BASE);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (u.pathname === '/live-hash') {
        res.end(PAGE('LIVE hash', { hashRoute: '#/room/123' }));
      } else if (u.pathname === '/live-state') {
        res.end(PAGE('LIVE state', { state: { room: 123, quality: 'hd' } }));
      } else {
        res.end(PAGE('PAGE ' + u.pathname));
      }
    }, DELAY);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-live-'));
  console.log(`profile: ${profileDir}`);
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: true,
    args: [
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--autoplay-policy=no-user-gesture-required',
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
    const bindSw = (w) => w.on('console', (m) => console.log('  [SW]', m.text()));
    bindSw(sw);
    context.on('serviceworker', bindSw);
    const extId = new URL(sw.url()).host;
    await sleep(1500);

    // 控制通道：扩展 popup 页
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
    await sleep(800);

    // 在 popup 里挂 webNavigation 时间线，看清「发起 → 提交 → 取消」的窗口
    await popup.evaluate(() => {
      window.__nav = [];
      const push = (type) => (d) => {
        if (d.frameId !== 0) return;
        if (!/newtab@|\/live|\/bookmark-target/.test(d.url)) return;
        window.__nav.push({ type, t: Math.round(performance.now()), url: d.url, tq: (d.transitionQualifiers || []).join(',') });
      };
      chrome.webNavigation.onBeforeNavigate.addListener(push('beforeNavigate'));
      chrome.webNavigation.onCommitted.addListener(push('committed'));
      chrome.webNavigation.onHistoryStateUpdated.addListener(push('historyStateUpdated'));
      chrome.webNavigation.onErrorOccurred.addListener(push('error'));
    });

    const page = await context.newPage();

    const scenario = async (label, urlPath, expectHash) => {
      await page.goto(BASE + urlPath, { waitUntil: 'load' });
      await sleep(1200); // 让视频真的播起来

      const before = await page.evaluate(() => ({
        docId: window.__docId,
        ticks: window.__ticks,
        paused: document.getElementById('v').paused,
        currentTime: document.getElementById('v').currentTime,
        hash: location.hash,
        histLen: history.length,
        state: JSON.stringify(history.state),
        url: location.href,
      }));
      console.log(`\n--- ${label} ---`);
      console.log('  原页 before:', JSON.stringify(before));

      const tabId = await popup.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => (x.url || '').startsWith(u));
        return t ? t.id : null;
      }, BASE + urlPath.split('#')[0]);

      const beforePages = new Set(context.pages());
      const dbgBefore = await popup.evaluate(async () => {
        window.__nav = [];
        const st = await chrome.storage.session.get('tabUrls');
        const tabs = await chrome.tabs.query({});
        return {
          tabUrls: st.tabUrls || {},
          tabs: tabs.map((t) => ({ id: t.id, url: t.url, active: t.active })),
        };
      });
      console.log('  扩展视角 before:', JSON.stringify(dbgBefore));

      await popup.evaluate(({ id, url }) => chrome.tabs.update(id, { url, active: true }), {
        id: tabId,
        url: NAV('/bookmark-target'),
      });

      let newTab = null;
      for (let i = 0; i < 60; i++) {
        const fresh = context.pages().filter((p) => !beforePages.has(p));
        if (fresh.length) { newTab = fresh[0]; break; }
        await sleep(200);
      }
      await sleep(2500);

      const navEvents = await popup.evaluate(async () => {
        const st = await chrome.storage.session.get('tabUrls');
        const tabs = await chrome.tabs.query({});
        return {
          nav: window.__nav,
          tabUrls: st.tabUrls || {},
          tabs: tabs.map((t) => ({ id: t.id, url: t.url, active: t.active })),
        };
      });
      console.log('  webNavigation 时间线:', JSON.stringify(navEvents.nav, null, 0));
      console.log('  扩展视角 after :', JSON.stringify({ tabUrls: navEvents.tabUrls, tabs: navEvents.tabs }));

      const after = await page.evaluate(() => ({
        docId: window.__docId,
        ticks: window.__ticks,
        paused: document.getElementById('v').paused,
        currentTime: document.getElementById('v').currentTime,
        hash: location.hash,
        histLen: history.length,
        state: JSON.stringify(history.state),
        url: location.href,
        routeBroken: window.__routeBroken || null,
        events: window.__events,
      })).catch((e) => ({ error: String(e).slice(0, 200) }));

      console.log('  新标签:', newTab ? newTab.url() : '未出现');
      if (after.error) {
        console.log('  原页 after :', after.error);
        check(`${label} 原页仍可访问`, false, after.error);
        if (newTab) await newTab.close().catch(() => {});
        return;
      }
      console.log('  原页 after :', JSON.stringify({
        docId: after.docId, ticks: after.ticks, paused: after.paused,
        currentTime: after.currentTime, hash: after.hash, histLen: after.histLen,
        state: after.state, url: after.url, routeBroken: after.routeBroken,
      }));
      console.log('  事件序列:');
      for (const e of after.events) {
        console.log(`    ${String(e.t).padStart(6)}ms ${e.type.padEnd(16)} hash=${e.hash || '(空)'} vis=${e.vis} paused=${e.paused} hist=${e.histLen}` +
          (e.from ? `  ${e.from} -> ${e.to}` : '') + (e.state !== undefined ? ` state=${e.state}` : ''));
      }

      check(`${label} 新标签打开了书签`, !!newTab && /\/bookmark-target/.test(newTab.url()));
      check(`${label} 文档未被卸载（docId 不变）`, after.docId === before.docId);
      check(`${label} 视频没被暂停`, after.paused === false, `paused=${after.paused}`);
      check(`${label} 视频播放位置在推进`, after.currentTime > before.currentTime + 0.5,
        `${before.currentTime.toFixed(2)} -> ${after.currentTime.toFixed(2)}`);
      check(`${label} hash 保持原值`, after.hash === expectHash, `期望 ${expectHash || '(空)'}，实际 ${after.hash || '(空)'}`);
      check(`${label} history 未被污染`, after.histLen === before.histLen,
        `${before.histLen} -> ${after.histLen}`);
      check(`${label} history.state 未被清空`, after.state === before.state,
        `${before.state} -> ${after.state}`);

      if (newTab) await newTab.close().catch(() => {});
    };

    // A. 无 hash 的原页（B 站 / Twitch / YouTube 这类）
    const only = process.env.ONLY || '';
    if (!only || only === 'A') await scenario('A 无 hash 原页', '/live', '');
    // B. 带 hash 路由的原页（SPA hash 路由）
    if (!only || only === 'B') await scenario('B 带 hash 路由', '/live-hash#/room/123', '#/room/123');
    // C. 原页在用 history.state
    if (!only || only === 'C') await scenario('C 带 history.state', '/live-state', '');
  } finally {
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    for (const f of failed) console.log(' -', f.name);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
