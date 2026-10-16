/**
 * Edge Better —— 星标异常诊断探针（一次性验证脚本）
 *
 * 查清：扩展开启时创建的前缀书签，为什么星标不点亮（扩展关闭时同样操作会点亮）？
 *   1. 创建前缀书签 → 立即回读 URL（确认书签实际状态）
 *   2. 导航到真实 URL → 回读书签（确认流程中书签未被改动）
 *   3. 截图星标
 *   4. 再创建一个真实 URL 书签作对照 → 截图星标（应点亮）
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8908;
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

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-diag-'));
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
    execFileSync(PYTHON, [CAPTURE_PY, out, 'probe'], { encoding: 'utf8' });
    console.log('  capture:', name);
  };

  // 回读所有书签（扁平化）
  const dumpBookmarks = async (popup) => {
    return await popup.evaluate(async () => {
      const tree = await chrome.bookmarks.getTree();
      const out = [];
      const walk = (nodes, depth) => {
        for (const n of nodes || []) {
          out.push(`${'  '.repeat(depth)}${n.title} :: ${n.url || '(folder)'}`);
          if (n.children) walk(n.children, depth + 1);
        }
      };
      walk(tree, 0);
      return out;
    });
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

    // 关键隔离：先关闭扩展（复现探针 B 的设置），再创建前缀书签
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'setEnabled', value: false }));
    await sleep(800);
    console.log('扩展已关闭');

    // 1. 创建书签（真实 URL——判定性对照：星标必须点亮）
    await popup.evaluate(() => chrome.bookmarks.create({
      title: 'diag-realcontrol', url: `http://127.0.0.1:${8908}/`,
    }));
    await sleep(1500); // 等 onCreated 的 800ms 延迟窗口完全过去
    console.log('=== 创建前缀书签后（等 1.5s）===');
    console.log((await dumpBookmarks(popup)).join('\n'));

    // 2. 导航到真实 URL（先过 about:blank——B 探针的结构）
    const page = await context.newPage();
    await page.bringToFront();
    await page.goto('about:blank');
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await sleep(1500);
    console.log('=== 导航后回读书签 ===');
    console.log((await dumpBookmarks(popup)).join('\n'));
    console.log('页面 URL:', await page.url());

    await capture('diag-1-prefixed');

    // 3. 对照：再创建一个真实 URL 书签
    await popup.evaluate(() => chrome.bookmarks.create({
      title: 'diag-real', url: `http://127.0.0.1:${8908}/`,
    }));
    await sleep(2000); // 等 onCreated 加前缀（800ms）
    console.log('=== 创建真实 URL 书签后（等 2s，应被自动加前缀）===');
    console.log((await dumpBookmarks(popup)).join('\n'));
    await sleep(1000);
    await page.bringToFront();
    await capture('diag-2-realadded');
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
