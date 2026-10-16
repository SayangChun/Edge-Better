/**
 * Edge Better —— bfcache 行为探针（一次性验证脚本）
 *
 * 目的：验证"页面 A → 导航到别的页 → goBack 回 A"时，A 是否能从
 * bfcache 无感恢复（DOM 状态、滚动位置保留，无刷新）。
 * 对比两种页面：带 beforeunload 监听器的 / 干净的。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8902;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', BASE);
    const withUnload = u.pathname === '/withunload';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>probe ${u.pathname}</title></head><body style="height:3000px"><h1>BF ${u.pathname}</h1><script>
window.__marker = 'set-at-' + Date.now();
window.__navType = performance.getEntriesByType('navigation')[0].type;
window.__unloaded = false;
${withUnload ? "window.addEventListener('beforeunload', () => { window.__unloaded = true; });" : ''}
</script></body></html>`);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-bfcache-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    viewport: null,
  });

  const results = [];
  const probe = async (name, pagePath) => {
    const page = await context.newPage();
    await page.goto(`${BASE}${pagePath}`, { waitUntil: 'load' });
    await page.evaluate(() => window.scrollTo(0, 700));
    await sleep(300);
    // 导航离开
    await page.goto(`${BASE}/other`, { waitUntil: 'load' });
    await sleep(500);
    // goBack 回原页
    await page.goBack({ waitUntil: 'load' });
    await sleep(500);
    const st = await page.evaluate(() => ({
      marker: window.__marker !== undefined,
      markerVal: window.__marker,
      scrollY: window.scrollY,
      navType: performance.getEntriesByType('navigation')[0].type,
      unloaded: window.__unloaded,
    }));
    const restored = st.marker && st.scrollY === 700;
    results.push({ name, ok: restored });
    console.log(`${restored ? 'PASS' : 'FAIL'}  ${name}  | ${JSON.stringify(st)}`);
    await page.close();
  };

  try {
    await probe('干净页面 goBack 恢复（bfcache 期望命中）', '/clean');
    await probe('带 beforeunload 监听器页面 goBack 恢复', '/withunload');
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
