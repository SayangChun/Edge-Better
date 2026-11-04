/**
 * 探针：扩展的 content script 能否抢下触控板捏合，并改成「只放大可视区域」
 *
 * 已验证的事实（probe-pinch-zoom.cjs）：
 *   - 桌面 Edge 的触控板捏合 = ctrl+wheel = page zoom（dpr 1.5→1.65，visualViewport.scale 恒为 1）
 *   - 页面主世界注册 non-passive 监听并 preventDefault 可以阻止 page zoom
 *
 * 本探针要回答：
 *   Q1 content script（isolated world）的 preventDefault 是否同样能阻止 page zoom？
 *   Q2 用 transform: scale() 做「局部放大」，视觉质量如何（截图取证）
 *   Q3 fixed 定位元素会不会跟着错位
 *
 * 运行：
 *   NODE_PATH=".../node_modules" ".../node.exe" tools/probe-cs-zoom.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const SRC_EXT = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PY = 'C:/Users/ZenithChunyang/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe';
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<html><head><title>cs zoom probe</title>
<style>
body{font:15px/1.5 "Segoe UI",sans-serif;margin:0;padding:16px}
.fixed{position:fixed;right:12px;top:12px;background:#fdd;border:1px solid #c66;padding:8px;font-weight:700}
p{margin:0 0 12px}
</style></head><body>
<div class="fixed">FIXED 元素</div>
<h1>CS ZOOM PROBE</h1>
${Array.from({ length: 40 }, (_, i) => `<p>第 ${i} 行：The quick brown fox jumps over the lazy dog. 中文测试文字，用于观察放大后的清晰度与边缘锯齿。</p>`).join('')}
</body></html>`;

function buildExt() {
  // 直接用项目本体：cs/zoom.js 已是正式实现，不需要再注入临时脚本
  return SRC_EXT;
}

function realWheel(wheel) {
  for (let i = 0; i < 6; i++) {
    try {
      const out = execFileSync(PY, [path.join(__dirname, 'wheel-zoom.py'),
        '--title', 'cs zoom probe',
        '--focus', '--click', '--wheel', String(wheel)], { encoding: 'utf8' }).trim();
      if (out.startsWith('OK')) return out;
    } catch (e) { /* 窗口未就绪，重试 */ }
    execFileSync(PY, ['-c', 'import time; time.sleep(1)']);
  }
  return 'NO_WINDOW';
}

async function snap(page) {
  return page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    vvScale: window.visualViewport.scale,
    docClientWidth: document.documentElement.clientWidth,
    htmlTransform: document.documentElement.style.transform,
    lastDy: document.documentElement.getAttribute('data-eb-dy'),

  }));
}

async function main() {
  const ext = buildExt();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-cszoom-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE, headless: false,
    args: [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--window-position=80,60', '--window-size=1100,800'],
    viewport: null,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/page?ebdebug`);
  await sleep(1200);

  const before = await snap(page);
  console.log('before:', JSON.stringify(before));

  // 真实输入偶发丢事件（窗口刚恢复时系统会吞掉合成鼠标事件），
  // 重试到事件确实到达页面为止
  let after = null;
  for (let i = 0; i < 4; i++) {
    console.log('input :', realWheel(600));
    await sleep(900);
    after = await snap(page);
    if (after.lastDy !== null) break;
    console.log('   （事件未到达，重试）');
  }

  const before2 = before;
  console.log('after :', JSON.stringify(after));

  const pageZoomed = after.dpr !== before.dpr || after.docClientWidth !== before.docClientWidth;
  console.log(`Q1 page zoom 是否被 content script 拦住: ${pageZoomed ? '否（没拦住）' : '是（已拦住）'}`);
  console.log(`Q2 transform 是否生效: ${after.htmlTransform || '(空)'}`);

  // Q3 fixed 元素行为：transform 会建立 containing block，fixed 可能退化成随文档滚动
  const fixedProbe = await page.evaluate(() => {
    const el = document.querySelector('.fixed');
    const r1 = el.getBoundingClientRect();
    window.scrollTo(0, 600);
    const r2 = el.getBoundingClientRect();
    return {
      topBeforeScroll: Math.round(r1.top), topAfterScroll: Math.round(r2.top),
      left: Math.round(r1.left),
      vw: window.innerWidth, vh: window.innerHeight,
    };
  });
  console.log('Q3 fixed 元素:', JSON.stringify(fixedProbe));
  console.log(`   => fixed 是否仍然固定在视口: ${fixedProbe.topBeforeScroll === fixedProbe.topAfterScroll ? '是' : '否（跟着文档滚走了）'}`);

  // 截图取证：看放大后的文字质量
  await page.screenshot({ path: path.join(__dirname, '_cszoom-after.png') });
  console.log('screenshot: tools/_cszoom-after.png');

  // Q4 排除列表：命中排除域名时应退回浏览器默认 page zoom
  console.log('\n=== Q4 排除列表 ===');
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await sw.evaluate(() => chrome.storage.local.set({ zoomExcluded: ['127.0.0.1'] }));
  await sleep(400);
  await page.reload();
  await sleep(1000);
  const b4 = await snap(page);
  let a4 = null;
  for (let i = 0; i < 4; i++) {
    realWheel(600);
    await sleep(900);
    a4 = await snap(page);
    if (a4.lastDy !== null || a4.dpr !== b4.dpr) break;
  }
  console.log('   before:', JSON.stringify(b4));
  console.log('   after :', JSON.stringify(a4));
  const zoomed = a4.dpr !== b4.dpr || a4.docClientWidth !== b4.docClientWidth;
  console.log(`   => 排除域名下恢复 page zoom: ${zoomed ? '是（正确）' : '否（仍然被接管）'}`);
  console.log(`   => transform 未被设置: ${a4.htmlTransform ? '否' : '是'}`);

  await context.close();
  server.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
