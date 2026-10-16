/**
 * Edge Better —— bfcache 权威判定探针（一次性验证脚本）
 *
 * 用 pageshow 事件的 persisted 标志判定"恢复是否来自 bfcache"：
 *   persisted=true  → bfcache 无感恢复（DOM 状态保留）
 *   persisted=false → 普通重载
 *
 * 变体：
 *   1. 普通往返（pageX → http 页 → goBack）
 *   2. 旧版扩展流程（redirect + open.html + history.back）
 *   3. 立即恢复（不等 500ms）
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = process.env.EXT_DIR || 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8905;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV = (p) => `http://newtab@127.0.0.1:${PORT}${p}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', BASE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>probe ${u.pathname}</title></head><body style="height:3000px"><h1>BF ${u.pathname}</h1><script>
window.__marker = 'm-' + Date.now();
window.__shows = 0;
window.__lastPersisted = null;
addEventListener('pageshow', (e) => { window.__shows++; window.__lastPersisted = e.persisted; });
</script></body></html>`);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-bfcache3-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: false,
    args: [
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-position=100,60',
      '--window-size=900,600',
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

  const report = (name, st) => {
    const bfcache = st.lastPersisted === true;
    console.log(`${bfcache ? 'BFCACHE' : 'RELOAD '}  ${name}  | ${JSON.stringify(st)}`);
  };

  try {
    await getSw();
    await sleep(1500);

    // ---- 变体 1：普通往返 ----
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/v1`, { waitUntil: 'load' });
      await page.evaluate(() => { window.__marker = 'marker-X'; window.scrollTo(0, 700); });
      await sleep(300);
      await page.goto(`${BASE}/v1-other`, { waitUntil: 'load' });
      await sleep(500);
      await page.goBack({ waitUntil: 'load' });
      await sleep(400);
      const st = await page.evaluate(() => ({
        marker: window.__marker, scrollY: window.scrollY,
        shows: window.__shows, lastPersisted: window.__lastPersisted,
        navType: performance.getEntriesByType('navigation')[0].type,
      }));
      report('变体1 普通往返（http 中间页 + 500ms）', st);
      await page.close();
    }

    // ---- 变体 2：旧版扩展流程（redirect + open.html）----
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/v2`, { waitUntil: 'load' });
      await page.evaluate(() => { window.__marker = 'marker-X'; window.scrollTo(0, 700); });
      await sleep(300);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: NAV('/v2-target') });
      await sleep(2000);
      const st = await page.evaluate(() => ({
        marker: window.__marker, scrollY: window.scrollY,
        shows: window.__shows, lastPersisted: window.__lastPersisted,
        navType: performance.getEntriesByType('navigation')[0].type,
        url: location.href,
      }));
      report('变体2 旧版扩展流程（open.html 中转）', st);
      await page.close();
    }

    // ---- 变体 3：立即恢复 ----
    {
      const page = await context.newPage();
      await page.goto(`${BASE}/v3`, { waitUntil: 'load' });
      await page.evaluate(() => { window.__marker = 'marker-X'; window.scrollTo(0, 700); });
      await sleep(300);
      await page.goto(`${BASE}/v3-other`, { waitUntil: 'load' });
      await page.goBack({ waitUntil: 'load' });
      await sleep(400);
      const st = await page.evaluate(() => ({
        marker: window.__marker, scrollY: window.scrollY,
        shows: window.__shows, lastPersisted: window.__lastPersisted,
        navType: performance.getEntriesByType('navigation')[0].type,
      }));
      report('变体3 立即恢复（无等待）', st);
      await page.close();
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
