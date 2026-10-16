/**
 * Edge Better —— bfcache 归因探针（一次性验证脚本）
 *
 * 目的：查清"经 open.html 恢复原页会重载、经普通 http 页恢复不会"的原因：
 *   1. 中间页是扩展页（chrome-extension://）→ 是否破坏 bfcache
 *   2. 恢复动作太快（立即 goBack）→ 是否破坏 bfcache
 *   3. 对照组：普通 http 页 + 稍等再 goBack（已知保留）
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8904;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', BASE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>probe ${u.pathname}</title></head><body style="height:3000px"><h1>BF ${u.pathname}</h1><script>
window.__marker = 'm-' + Date.now();
</script></body></html>`);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-bfcache2-'));
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

  const results = [];
  const run = async (name, intermediateUrl, waitMs) => {
    const page = await context.newPage();
    await page.goto(`${BASE}/pageX`, { waitUntil: 'load' });
    await page.evaluate(() => { window.__marker = 'marker-X'; window.scrollTo(0, 700); });
    await sleep(300);
    await page.goto(intermediateUrl, { waitUntil: 'domcontentloaded' });
    await sleep(waitMs);
    await page.goBack({ waitUntil: 'load' });
    await sleep(400);
    const st = await page.evaluate(() => ({
      marker: window.__marker,
      scrollY: window.scrollY,
      navType: performance.getEntriesByType('navigation')[0].type,
      url: location.href,
    }));
    const ok = st.marker === 'marker-X';
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  | ${JSON.stringify(st)}`);
    await page.close();
  };

  try {
    const sw = await getSw();
    const extId = new URL(sw.url()).host;
    await sleep(1500);
    // 1. 中间页是扩展页
    await run('扩展页(popup.html)作中间页 → goBack 恢复', `chrome-extension://${extId}/popup.html`, 300);
    // 2. 普通 http 页 + 立即（10ms）恢复
    await run('普通 http 页作中间页 + 10ms 后恢复', `${BASE}/other`, 10);
    // 3. 对照组：普通 http 页 + 500ms 后恢复
    await run('普通 http 页作中间页 + 500ms 后恢复', `${BASE}/other2`, 500);
  } finally {
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
