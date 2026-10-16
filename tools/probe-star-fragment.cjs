/**
 * Edge Better —— 星标 × fragment 取消流程回归探针（一次性验证脚本）
 *
 * 目的：验证 v0.2 的 fragment 取消机制（当前页 → pageX#edge-better → replaceState
 * 清理）不会影响地址栏星标对已收藏页面的识别。
 *
 * 流程：
 *   1. 创建 newtab@ 前缀书签（直接以带前缀 URL 创建，onCreated 会跳过）
 *   2. 导航到 pageX → 截图（基线：星标应点亮）
 *   3. CDP 触发 newtab@ 书签导航（扩展流程：新标签 + 当前页 fragment 取消）
 *   4. 原页置前 → 截图（结束态：星标应仍点亮）
 *   5. 同时检查原页标记/滚动位置（确认走的是 fragment 取消路径）
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8906;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV = (p) => `http://newtab@127.0.0.1:${PORT}${p}`;
const OUT_DIR = path.join(EXT_DIR, '.tmp-star-probe');
const PYTHON = 'C:/Users/ZenithChunyang/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe';
const CAPTURE_PY = path.join(EXT_DIR, 'tools', 'capture-window.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', BASE);
    const body = `<html><head><title>probe ${u.pathname}</title></head><body style="height:3000px"><h1>PROBE ${u.pathname}</h1></body></html>`;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    }, 250); // 模拟真实站点往返，保证 fragment 取消赢得竞态
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-starfrag-'));
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

    // popup 页作为 chrome.bookmarks API 通道（扩展保持开启）
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

    // 直接创建带前缀的书签（onCreated 对已带前缀的 URL 会跳过）
    await popup.evaluate(() => chrome.bookmarks.create({
      title: 'probe-prefixed',
      url: 'http://newtab@127.0.0.1:8906/',
    }));
    await sleep(500);
    await popup.close().catch(() => {});

    const page = await context.newPage();
    await page.bringToFront();
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.evaluate(() => { window.__marker = 'marker-X'; window.scrollTo(0, 700); });
    await sleep(1200);
    console.log('--- 基线：前缀书签已存在，导航到真实 URL ---');
    await capture('frag-baseline');

    // 触发书签导航（扩展流程）
    console.log('--- 触发 newtab@ 书签导航（fragment 取消流程）---');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: NAV('/frag-target') });
    await sleep(2500); // 等新标签加载 + fragment 取消 + replaceState 清理
    await page.bringToFront();
    await sleep(500);
    console.log('--- 结束态：原页（fragment 已清理）---');
    await capture('frag-after');

    const st = await page.evaluate(() => ({
      marker: window.__marker,
      scrollY: window.scrollY,
      navType: performance.getEntriesByType('navigation')[0].type,
      url: location.href,
    }));
    console.log('原页状态:', JSON.stringify(st));
    console.log('fragment 取消路径确认（标记保留）:', st.marker === 'marker-X');
    console.log('地址栏 URL 已清理（无 #edge-better 残留）:', !st.url.includes('#'));
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
