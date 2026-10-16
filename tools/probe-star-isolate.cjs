/**
 * Edge Better —— 星标变暗归因探针（一次性验证脚本）
 *
 * 隔离测试：哪一步让星标从点亮变空心？
 *   A. fragment 导航（pageX → pageX#edge-better，同文档）→ 星标？
 *   B. replaceState 改回原 URL → 星标？
 *   C. 轻触书签（update 同值）→ 星标是否恢复？
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8907;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(EXT_DIR, '.tmp-star-probe');
const PYTHON = 'C:/Users/ZenithChunyang/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe';
const CAPTURE_PY = path.join(EXT_DIR, 'tools', 'capture-window.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>probe</title></head><body><h1>PROBE</h1></body></html>');
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-stariso-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: false,
    args: [
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-size=1100,720',
      '--window-position=120,80',
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

  const capture = async (name) => {
    const out = path.join(OUT_DIR, name + '.png');
    const stdout = execFileSync(PYTHON, [CAPTURE_PY, out, 'probe'], { encoding: 'utf8' });
    console.log(`  capture ${name}: ${stdout.trim()}`);
  };

  try {
    const sw = await getSw();
    const extId = new URL(sw.url()).host;
    await sleep(2000);

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
    await sleep(1000);
    await popup.evaluate(() => chrome.bookmarks.create({
      title: 'iso', url: `http://newtab@127.0.0.1:${8907}/`,
    }));
    await sleep(500);
    await popup.close().catch(() => {});

    const page = await context.newPage();
    await page.bringToFront();
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(1200);

    console.log('--- 基线 ---');
    await capture('iso-0-baseline');

    // A: fragment 导航
    console.log('--- A: fragment 导航（pageX#edge-better）---');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `${BASE}/#edge-better` });
    await sleep(1200);
    await capture('iso-A-fragment');
    console.log('当前 URL:', await page.url());

    // B: replaceState 回原 URL
    console.log('--- B: replaceState 回原 URL ---');
    await page.evaluate(() => history.replaceState(null, '', location.pathname));
    await sleep(1200);
    await capture('iso-B-replacestate');

    // C: 轻触书签（update 同值）
    console.log('--- C: 轻触书签（update 同值 URL）---');
    const existing2 = new Set(context.pages());
    const bcdp2 = await context.browser().newBrowserCDPSession();
    await bcdp2.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    let popup2 = null;
    for (let i = 0; i < 50; i++) {
      const fresh = context.pages().filter((p) => !existing2.has(p));
      if (fresh.length) { popup2 = fresh[0]; break; }
      await sleep(200);
    }
    if (popup2) {
      await sleep(1000);
      await popup2.evaluate(async () => {
        const tree = await chrome.bookmarks.getTree();
        const walk = (nodes) => {
          for (const n of nodes || []) {
            if (n.url && n.url.includes('newtab@')) return n;
            if (n.children) { const r = walk(n.children); if (r) return r; }
          }
          return null;
        };
        const node = walk(tree);
        if (node) await chrome.bookmarks.update(node.id, { url: node.url }); // 同值 update
      });
      await sleep(1500);
      await page.bringToFront();
      await sleep(500);
      await capture('iso-C-touch');
      await popup2.close().catch(() => {});
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
