/**
 * EdgeBetter —— 星标识别探针（一次性验证脚本，不属于测试套件）
 *
 * 目的：实测当前机器上 Edge 地址栏星标对 newtab@ 前缀书签的识别行为
 *   A. 对照：真实 URL 书签          → 期望星标点亮
 *   B. 被测：newtab@ 前缀书签        → 观察星标是否点亮
 *   C. 基线：无书签
 * 每个状态截两张图（普通状态 + Ctrl+D 气泡状态），供人工判读。
 *
 * 依赖：本机真实 Edge（非 headless，会短暂弹出窗口）、tools/capture-window.py
 *
 * 运行：
 *   NODE_PATH="C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/workspace/node_modules" \
 *     "C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe" tools/probe-star-state.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8901;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(EXT_DIR, '.tmp-star-probe');
const PYTHON = 'C:/Users/ZenithChunyang/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe';
const CAPTURE_PY = path.join(EXT_DIR, 'tools', 'capture-window.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>probe</title></head><body><h1>PROBEPAGE</h1></body></html>');
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgebetter-star-'));
  console.log('profile:', profileDir);
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
    const stdout = execFileSync(
      PYTHON,
      [CAPTURE_PY, out, 'probe'],
      { encoding: 'utf8' },
    );
    console.log(`  capture ${name}: ${stdout.trim()}`);
  };

  try {
    const sw = await getSw();
    console.log('SW:', sw.url());
    const extId = new URL(sw.url()).host;
    await sleep(2000);
    console.log('打开 popup 页作为 chrome.bookmarks 通道…');

    // 关闭扩展本体（避免 onCreated 自动给对照书签加前缀），只借 popup 页作为 chrome.bookmarks 通道
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
    console.log('popup 页:', popup.url());
    await sleep(1000);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'setEnabled', value: false }));
    await sleep(600);
    console.log('扩展已关闭（仅作 API 通道）');

    // 书签管理辅助：清除所有指向目标 URL（含 newtab@ 变体）的书签，然后可选地新建
    const setBookmark = async (url, title) => {
      await popup.evaluate(async ({ target, t }) => {
        const strip = (x) => String(x).replace(/^https?:\/\/newtab@/i, '');
        const targetStripped = target ? strip(target) : null;
        const tree = await chrome.bookmarks.getTree();
        const removeAll = async (nodes) => {
          for (const n of nodes) {
            if (n.url && strip(n.url) === targetStripped) await chrome.bookmarks.remove(n.id);
            if (n.children) await removeAll(n.children);
          }
        };
        await removeAll(tree);
        if (target) await chrome.bookmarks.create({ title: t, url: target });
      }, { target: url, t: title });
    };

    const page = await context.newPage();
    await page.bringToFront();

    const probeState = async (label, url, title) => {
      await setBookmark(url, title);
      await page.goto('about:blank');
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await sleep(1500);
      await page.bringToFront();
      await sleep(400);
      // 回读书签真实状态（验证 create 的 URL 是否被规范化）
      const dump = await popup.evaluate(async () => {
        const tree = await chrome.bookmarks.getTree();
        const out = [];
        const walk = (nodes) => {
          for (const n of nodes || []) {
            if (n.url) out.push(n.url);
            if (n.children) walk(n.children);
          }
        };
        walk(tree);
        return out;
      });
      console.log(`  [${label}] 书签库: ${JSON.stringify(dump)}`);
      await capture(`${label}-plain`);
      await page.keyboard.press('Control+d');
      await sleep(900);
      await capture(`${label}-ctrld`);
      await page.keyboard.press('Escape');
      await sleep(400);
    };

    console.log('--- 状态 A：真实 URL 书签（对照）---');
    await probeState('A-real', BASE + '/', 'probe-real');
    console.log('--- 状态 B：newtab@ 前缀书签（被测）---');
    await probeState('B-prefixed', `http://newtab@127.0.0.1:${PORT}/`, 'probe-prefixed');
    console.log('--- 状态 C：无书签（基线）---');
    await probeState('C-none', null, 'probe-none');

    await popup.close().catch(() => {});
  } finally {
    await context.close().catch(() => {});
    server.close();
    // Edge 进程退出需要时间，清理失败不致命（临时目录），绝不能被它掩盖真正的错误
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(1000);
      }
    }
  }
  console.log('截图目录:', OUT_DIR);
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
