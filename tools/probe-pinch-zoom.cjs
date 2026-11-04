/**
 * 探针：桌面 Edge 上「触控板捏合」到底改的是什么
 *
 * Chromium 有两条完全不同的缩放路径：
 *   page zoom      —— 改 CSS 像素与设备像素的比例，布局重排（等价 Ctrl +/-）
 *   visual viewport zoom —— 只放大可视区域，布局不变，可平移（触屏捏合）
 *
 * 判据：
 *   page zoom      → devicePixelRatio 变，visualViewport.scale 恒为 1
 *   visual zoom    → visualViewport.scale 变，devicePixelRatio 不变
 *
 * 触控板捏合在 Chromium 里被合成为 ctrl+wheel，所以用 CDP 发带 ctrl 的
 * mouseWheel 来模拟（触摸屏的 synthesizePinchGesture 走的是另一条路，不能用）。
 *
 * 运行：
 *   NODE_PATH=".../node_modules" ".../node.exe" tools/probe-pinch-zoom.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8921;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<html><head><title>pinch probe</title>
<style>body{font:16px/1.6 sans-serif;margin:0;padding:20px}
.box{width:100%;height:120px;background:#eef;margin:10px 0;border:1px solid #99c}
</style></head><body>
<h1>PINCH PROBE</h1>
${Array.from({ length: 30 }, (_, i) => `<div class="box">row ${i}</div>`).join('')}
<script>
window.__events = [];
addEventListener('wheel', (e) => {
  window.__events.push({ ctrl: e.ctrlKey, dy: e.deltaY, cancelable: e.cancelable, defaultPrevented: e.defaultPrevented });
}, { passive: true });
</script></body></html>`;

async function snapshot(page) {
  return page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    vvScale: window.visualViewport ? window.visualViewport.scale : null,
    vvWidth: window.visualViewport ? Math.round(window.visualViewport.width) : null,
    innerWidth: window.innerWidth,
    docClientWidth: document.documentElement.clientWidth,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
  }));
}

const { execFileSync } = require('child_process');
const PY = process.env.PYTHON ||
  'C:/Users/ZenithChunyang/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe';

/** 用真实 Ctrl+滚轮模拟触控板捏合（CDP 合成事件不触发 page zoom） */
function pinchReal(wheel) {
  // 窗口刚起来时标题还没稳定，重试几次
  for (let i = 0; i < 6; i++) {
    try {
      const out = execFileSync(PY, [
        path.join(__dirname, 'wheel-zoom.py'),
        '--focus', '--click', '--wheel', String(wheel),
      ], { encoding: 'utf8' }).trim();
      if (out.startsWith('OK')) return out;
      if (i === 5) return out;
    } catch (e) {
      if (i === 5) return `ERR ${e.message}`;
    }
    execFileSync(PY, ['-c', 'import time; time.sleep(1)']);
  }
  return 'NO_WINDOW';
}

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-pinch-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--window-position=80,60', '--window-size=1100,800'],
    viewport: null,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/plain`);
  await sleep(800);

  console.log('=== 1. 普通页面：真实 Ctrl+滚轮（模拟触控板捏合）===');
  const before = await snapshot(page);
  console.log('   before:', JSON.stringify(before));
  console.log('   input :', pinchReal(600));
  await sleep(800);
  const after = await snapshot(page);
  console.log('   after :', JSON.stringify(after));
  const events = await page.evaluate(() => window.__events.slice(0, 3));
  console.log('   wheel events 样本:', JSON.stringify(events));

  const pageZoom = after.dpr !== before.dpr || after.docClientWidth !== before.docClientWidth;
  const visualZoom = after.vvScale !== before.vvScale;
  console.log(`   => page zoom 生效: ${pageZoom}   visual zoom 生效: ${visualZoom}`);

  console.log('\n=== 2. 页面自己 preventDefault 后，page zoom 还生效吗 ===');
  await page.evaluate(() => {
    addEventListener('wheel', (e) => {
      if (e.ctrlKey) { e.preventDefault(); window.__blocked = (window.__blocked || 0) + 1; }
    }, { passive: false });
  });
  const b2 = await snapshot(page);
  console.log('   input :', pinchReal(600));
  await sleep(800);
  const a2 = await snapshot(page);
  const blocked = await page.evaluate(() => window.__blocked || 0);
  console.log('   before:', JSON.stringify(b2));
  console.log('   after :', JSON.stringify(a2));
  console.log(`   preventDefault 命中: ${blocked} 次`);
  console.log(`   => page zoom 仍生效: ${a2.dpr !== b2.dpr || a2.docClientWidth !== b2.docClientWidth}`);

  console.log('\n=== 3. visualViewport 是否可被脚本主动缩放 ===');
  const canSetScale = await page.evaluate(() => {
    const before = window.visualViewport.scale;
    let ok = true, err = '';
    try {
      // 标准里 visualViewport.scale 是只读的
      window.visualViewport.scale = 2;
    } catch (e) { ok = false; err = e.message; }
    return { before, after: window.visualViewport.scale, assignable: ok, err };
  });
  console.log('   ', JSON.stringify(canSetScale));

  await context.close();
  server.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
