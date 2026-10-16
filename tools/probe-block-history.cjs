/**
 * Edge Better —— block 行为聚焦探针（一次性验证脚本）
 *
 * 目的：查清 DNR block 拦截主框架导航后的真实行为：
 *  1. 历史栈结构（pageX 是否还在、错误页是否占位）
 *  2. 手动 goBack 能否恢复原页（bfcache 恢复 or 重载）
 *  3. tabs.onUpdated 是否为 chrome-error 触发（从扩展侧日志推断）
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = process.env.EXT_DIR || 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV = (p) => `http://newtab@127.0.0.1:${PORT}${p}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', BASE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>probe</title></head><body style="height:3000px"><h1>PROBE ${u.pathname}</h1><script>
window.__marker = 'm-' + Date.now();
window.__navType = performance.getEntriesByType('navigation')[0].type;
window.__unloaded = false;
window.addEventListener('beforeunload', () => { window.__unloaded = true; });
</script></body></html>`);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-block-'));
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
    await getSw();
    await sleep(1500);
    const page = await context.newPage();
    await page.goto(`${BASE}/pageX`, { waitUntil: 'load' });
    await page.evaluate(() => { window.__marker = 'marker-X'; window.scrollTo(0, 700); });
    await sleep(300);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');

    console.log('--- 触发 newtab@ 导航 ---');
    await cdp.send('Page.navigate', { url: NAV('/pageY') });
    await sleep(1500);

    console.log('当前 URL:', await page.url());

    // 0. 立即检查原页状态（流程可能已完成——旧版 redirect 路线会自动恢复）
    const st0 = await page.evaluate(() => ({
      marker: window.__marker,
      scrollY: window.scrollY,
      navType: performance.getEntriesByType('navigation')[0].type,
      unloaded: window.__unloaded,
      url: location.href,
    }));
    console.log('流程后原页状态:', JSON.stringify(st0));
    console.log('状态保留(标记仍在):', st0.marker === 'marker-X');

    // 1. 历史栈结构
    const hist = await cdp.send('Page.getNavigationHistory');
    console.log('历史栈:', JSON.stringify(hist.entries.map((e) => e.url)));
    console.log('当前历史索引:', hist.currentIndex);

    // 2. 手动 goBack（仅当标签不在原页时才有意义）
    if ((await page.url()) !== `${BASE}/pageX`) {
      try {
        await page.goBack({ waitUntil: 'load', timeout: 5000 });
        await sleep(500);
        const st = await page.evaluate(() => ({
          marker: window.__marker,
          scrollY: window.scrollY,
          navType: performance.getEntriesByType('navigation')[0].type,
          unloaded: window.__unloaded,
          url: location.href,
        }));
        console.log('手动 goBack 后:', JSON.stringify(st));
      } catch (e) {
        console.log('手动 goBack 失败:', String(e).slice(0, 200));
      }
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
