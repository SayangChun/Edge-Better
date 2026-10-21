/**
 * 探针：验证「关闭窗口/标签页时弹确认框」在扩展层是否可行
 *
 * 要回答两个问题：
 *   Q1 content script 注册的 beforeunload 能否让 Edge 在关闭时弹原生确认框？
 *      （页面自身注册的 beforeunload 一定可以，但扩展注入的需要单独验证）
 *   Q2 新标签页（edge://newtab）能否注入 content script？
 *
 * 做法：把项目复制到临时目录，往 manifest 里加一条 content_scripts 注入
 * beforeunload，用 playwright-core 起真机 Edge，再用 runBeforeUnload 关闭页面
 * 看有没有 dialog 事件。
 *
 * 运行：
 *   NODE_PATH=".../node_modules" ".../node.exe" tools/probe-close-confirm.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const SRC_EXT = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8907;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复制扩展并注入 beforeunload content script
function buildTestExt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-closeext-'));
  for (const f of fs.readdirSync(SRC_EXT)) {
    if (f === 'node_modules' || f === '.git' || f.endsWith('.zip')) continue;
    const s = path.join(SRC_EXT, f);
    const d = path.join(dir, f);
    if (fs.statSync(s).isDirectory()) {
      if (f === 'tools' || f === 'test') continue;
      fs.cpSync(s, d, { recursive: true });
    } else {
      fs.copyFileSync(s, d);
    }
  }
  fs.mkdirSync(path.join(dir, 'cs'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cs', 'guard.js'),
    `window.addEventListener('beforeunload', (e) => {
       e.preventDefault();
       e.returnValue = '确认关闭？';
       return '确认关闭？';
     });
     document.documentElement.setAttribute('data-cs-guard', '1');
     console.log('[cs] beforeunload guard installed');`
  );
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  mf.content_scripts = [
    { matches: ['http://*/*', 'https://*/*'], js: ['cs/guard.js'], run_at: 'document_start', all_frames: false },
  ];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
  return dir;
}

async function main() {
  const extDir = buildTestExt();
  console.log('ext copy:', extDir);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>guard test</title></head><body><h1>GUARD TEST</h1>
      <script>window.__pageLoadedAt = Date.now();</script></body></html>`);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-closeprofile-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: false,
    args: [
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
    ],
    viewport: null,
  });

  const page = await context.newPage();
  await page.goto(`${BASE}/a`);
  await sleep(1200);

  // Q1: content script 是否注入成功
  const injected = await page.evaluate(() => document.documentElement.getAttribute('data-cs-guard'));
  console.log(`Q1a content script 注入: ${injected === '1' ? 'YES' : 'NO'}`);

  // 制造 user activation（beforeunload 需要 sticky activation）
  await page.mouse.click(400, 300);
  await sleep(300);

  // Q1b: runBeforeUnload 关闭 → 是否出现原生确认 dialog
  let dialogSeen = false;
  let dialogText = '';
  page.on('dialog', async (d) => {
    dialogSeen = true;
    dialogText = `${d.type()}: ${d.message()}`;
    await d.dismiss(); // 取消关闭
  });

  const closePromise = page.close({ runBeforeUnload: true }).catch((e) => `close-error: ${e.message}`);
  await sleep(2500);
  const stillOpen = !page.isClosed();
  console.log(`Q1b 关闭时弹确认框: ${dialogSeen ? 'YES' : 'NO'}${dialogText ? '  | ' + dialogText : ''}`);
  console.log(`Q1c 取消后页面仍存活: ${stillOpen ? 'YES' : 'NO'}`);

  if (page.isClosed()) {
    await closePromise;
  }

  // Q2: 新标签页能否注入 content script
  const ntp = await context.newPage();
  await ntp.goto('edge://newtab').catch(() => {});
  await sleep(1500);
  const ntpInjected = await ntp
    .evaluate(() => document.documentElement.getAttribute('data-cs-guard'))
    .catch((e) => `evaluate-error: ${e.message}`);
  console.log(`Q2 edge://newtab 注入: ${ntpInjected === '1' ? 'YES' : `NO (${ntpInjected})`}`);

  await context.close();
  server.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
