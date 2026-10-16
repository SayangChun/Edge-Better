/**
 * EdgeBetter —— 「收藏到非默认文件夹却仍落在默认文件夹」UI 探针（一次性验证脚本）
 *
 * 这条 bug 只存在于真实浏览器的收藏气泡（favorites bubble）交互里，
 * 纯 API 复现不出来，必须点真窗口。依赖 tools/capture-window.py（截图）
 * 与 tools/click-point.py（真实鼠标点击 / 抬窗口）。
 *
 * 关键实测结论：Playwright 的合成按键到不了浏览器加速键（Ctrl+D / Ctrl+Shift+B
 * 均无效），所以这里一律走真实鼠标点击。
 *
 * MODE=discover  点星标打开气泡并截图（PrintWindow + 整屏），供人工判读坐标
 * MODE=repro     再按 DROP_ / ITEM_ / DONE_ 坐标走完：展开文件夹下拉 → 选目标文件夹
 *                → 完成，最后回读书签树，看它究竟落在哪个文件夹
 *
 * 窗口位置 / 尺寸固定，坐标因此可复现。屏幕物理坐标 = 窗口左上角 + 窗口内偏移，
 * 窗口左上角由 capture-window.py 打印。
 *
 * 运行：
 *   NODE_PATH="..." "…/node.exe" tools/probe-folder.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8912;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(EXT_DIR, '.tmp-folder-probe');
const PYTHON = 'C:/Users/ZenithChunyang/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe';
const CAPTURE_PY = path.join(EXT_DIR, 'tools', 'capture-window.py');
const CLICK_PY = path.join(EXT_DIR, 'tools', 'click-point.py');
const MODE = process.env.MODE || 'discover';

/** 窗口内偏移（本机 150% 缩放、窗口 1200x800 逻辑 → 1800x1200 物理，像素分析标定） */
const OFF = {
  pageBody: [900, 600], // 用于先把窗口激活（点页面空白处，无害）
  star: [1537, 89], // 地址栏右侧星标（工具条图标行 y≈73..101，星标 x 1525..1548）
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let winOrigin = null; // [left, top]

function runPy(args) {
  return execFileSync(PYTHON, args, { encoding: 'utf8' }).trim();
}

function focus() {
  const out = runPy([CLICK_PY, '--focus']);
  const m = /rect=\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)/.exec(out);
  if (m) winOrigin = [Number(m[1]), Number(m[2])];
  console.log('  focus:', out);
  return winOrigin;
}

function capture(name, screen = false) {
  const out = path.join(OUT_DIR, name + '.png');
  const stdout = runPy([CAPTURE_PY, out, screen ? '--screen' : 'probe']);
  const m = /at \((-?\d+),(-?\d+)\)/.exec(stdout);
  if (m) winOrigin = [Number(m[1]), Number(m[2])];
  console.log(`  capture ${name}: ${stdout}`);
}

/** 把每个可见 Edge 顶层窗口各抓一张：收藏气泡是独立 HWND，只有这样才能抓到 */
function captureAll(name) {
  const out = path.join(OUT_DIR, name + '.png');
  const stdout = runPy([CAPTURE_PY, out, '--all']);
  console.log(`  capture-all ${name}:`);
  for (const line of stdout.split('\n')) console.log('    ' + line);
}

function clickOff([ox, oy]) {
  if (!winOrigin) throw new Error('还没有窗口原点，先 focus/capture 一次');
  const x = winOrigin[0] + ox;
  const y = winOrigin[1] + oy;
  console.log(`  click 窗口内(${ox},${oy}) → 屏幕(${x},${y}): ${runPy([CLICK_PY, String(x), String(y)])}`);
}

/** 原样点击屏幕坐标（不抬窗口、不抢焦点）——点收藏气泡必须用它 */
function rawClick(x, y) {
  console.log(`  raw click 屏幕(${x},${y}): ${runPy([CLICK_PY, '--raw', String(x), String(y)])}`);
}

/** 发一个按键（气泡里按钮不吃注入点击，回车可触发默认按钮） */
function pressKey(vk) {
  console.log(`  key vk=${vk}: ${runPy([CLICK_PY, '--key', String(vk)])}`);
}

/** 枚举可见 Edge 顶层窗口，返回 [{hwnd, cls, title, rect}] */
function listWindows() {
  const out = runPy([CAPTURE_PY, 'tmp.png', '--list']);
  const res = [];
  for (const line of out.split('\n')) {
    const m = /hwnd=(\d+) class='([^']*)' rect=\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\) size=(\d+)x(\d+) title='(.*)'/.exec(line);
    if (m) {
      res.push({
        hwnd: Number(m[1]),
        cls: m[2],
        rect: [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])],
        size: [Number(m[7]), Number(m[8])],
        title: m[9],
      });
    }
  }
  return res;
}

/**
 * 定位气泡/下拉弹层：排除主窗口与用户自己的 Edge 窗口（都很宽），
 * 取剩余窗口里最上面那个。
 */
function findPopup(mainHwnd, { titleLike = null, excludeTitle = null } = {}) {
  let pool = listWindows().filter((w) => w.hwnd !== mainHwnd && w.size[0] < 900);
  if (titleLike) pool = pool.filter((w) => w.title.includes(titleLike));
  if (excludeTitle) pool = pool.filter((w) => !w.title.includes(excludeTitle));
  return pool[0] || null;
}

/** 在弹层内按相对偏移做原样点击 */
function clickPopup(win, [rx, ry]) {
  if (!win) throw new Error('没找到弹层窗口');
  const x = win.rect[0] + rx;
  const y = win.rect[1] + ry;
  console.log(`  弹层 hwnd=${win.hwnd} title='${win.title}' 内(${rx},${ry})`);
  rawClick(x, y);
}

const envOff = (prefix, def) => {
  const x = process.env[prefix + '_X'];
  const y = process.env[prefix + '_Y'];
  return x !== undefined && y !== undefined ? [Number(x), Number(y)] : def;
};

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>probe folder test</title></head><body><h1>PROBE FOLDER</h1></body></html>');
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgebetter-folder-'));
  console.log(`profile: ${profileDir}  MODE=${MODE}`);
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: false,
    args: [
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--window-position=80,60',
      '--window-size=1200,800',
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

  const dumpTree = async () => {
    try {
      const sw = await getSw();
      const lines = await sw.evaluate(async () => {
        const t = await chrome.bookmarks.getTree();
        const out = [];
        const walk = (nodes, depth) => {
          for (const n of nodes || []) {
            out.push(`${'  '.repeat(depth)}${n.title} :: ${n.url || '(文件夹)'}`);
            if (n.children) walk(n.children, depth + 1);
          }
        };
        walk(t, 0);
        return out;
      });
      return lines.join('\n');
    } catch (e) {
      return '(读取失败: ' + String(e).slice(0, 80) + ')';
    }
  };

  // ---- 时间线追踪：每 150ms 快照一次"书签在哪个文件夹 + URL"，并记录 SW 收到的书签事件 ----
  const T0 = Date.now();
  const trace = [];
  let polling = false;
  const snapshot = async () => {
    const sw = await getSw();
    return sw.evaluate(async () => {
      const t = await chrome.bookmarks.getTree();
      const out = [];
      const walk = (nodes, parentTitle) => {
        for (const n of nodes || []) {
          if (n.url) out.push(`${parentTitle}>${n.title}=${n.url.replace(/^https?:\/\/newtab@/, '')}`);
          if (n.children) walk(n.children, n.title || 'root');
        }
      };
      walk(t, '');
      return out.join(' ; ');
    });
  };
  const startPoll = () => {
    polling = true;
    (async () => {
      while (polling) {
        try {
          trace.push(`t+${Date.now() - T0}ms  ${await snapshot()}`);
        } catch (e) {
          trace.push(`t+${Date.now() - T0}ms  (快照失败 ${String(e).slice(0, 40)})`);
        }
        await sleep(150);
      }
    })();
  };
  const stopPoll = async () => {
    polling = false;
    await sleep(250);
  };

  try {
    const sw0 = await getSw();
    // 记录 SW 收到的书签事件（含它自己那次 update 触发的 onChanged）
    await sw0.evaluate(() => {
      globalThis.__ev = [];
      const log = (t) => (...a) => globalThis.__ev.push(`${t} +${Date.now() - globalThis.__t0}ms ${JSON.stringify(a)}`);
      globalThis.__t0 = Date.now();
      chrome.bookmarks.onCreated.addListener(log('created'));
      chrome.bookmarks.onMoved.addListener(log('moved'));
      chrome.bookmarks.onChanged.addListener(log('changed'));
      // 关键：收藏气泡是独立窗口，气泡打开/关闭时焦点会离开/回到浏览器窗口，
      // 这里看扩展能不能通过 windows.onFocusChanged / tabs.onActivated 感知到
      chrome.windows.onFocusChanged.addListener((wid) => globalThis.__ev.push(`focusChanged +${Date.now() - globalThis.__t0}ms windowId=${wid}`));
      chrome.tabs.onActivated.addListener((info) => globalThis.__ev.push(`tabActivated +${Date.now() - globalThis.__t0}ms ${JSON.stringify(info)}`));
    });
    await sleep(2000);
    if (process.env.NOEXT === '1') {
      // 对照组：关掉扩展，onCreated 不再改写书签 URL，其余流程完全一致
      await sw0.evaluate(() => chrome.storage.local.set({ enabled: false }));
      await sleep(600);
      console.log('>>> 对照组：扩展已关闭，不做任何书签改写');
    }
    const page = await context.newPage();
    await page.goto(`${BASE}/probe`, { waitUntil: 'load' });
    await page.bringToFront();
    await sleep(1000);

    focus();
    capture('01-page');
    // 先把窗口激活：点页面空白处（无害），避免第一次点击只被当作"激活窗口"
    clickOff(OFF.pageBody);
    await sleep(400);
    captureAll('01b-windows');

    if (MODE === 'clicks') {
      // 通用模式：CLICKS="x,y;x,y" 窗口内偏移依次点；"aX,Y" = 屏幕绝对坐标（原样点，不抬窗口）
      const list = (process.env.CLICKS || '').split(';').filter(Boolean);
      let i = 0;
      for (const raw of list) {
        i += 1;
        console.log(`--- click#${i} ${raw} ---`);
        if (raw.startsWith('a')) {
          const [ax, ay] = raw.slice(1).split(',').map(Number);
          rawClick(ax, ay);
        } else if (raw.startsWith('k')) {
          pressKey(Number(raw.slice(1)));
        } else {
          clickOff(raw.split(',').map(Number));
        }
        await sleep(1200);
        capture(`c${i}-window`);
        captureAll(`c${i}-windows`);
      }
      console.log('--- 书签树 ---');
      console.log(await dumpTree());
      const evc = await getSw().then((sw) => sw.evaluate(() => globalThis.__ev || []));
      console.log('--- SW 收到的事件 ---');
      for (const line of evc) console.log('  ' + line);
      return;
    }

    console.log('--- 点星标，打开收藏气泡 ---');
    clickOff(envOff('STAR', OFF.star));
    await sleep(1500);
    capture('02-window');
    captureAll('02-windows');
    console.log('--- 气泡打开期间的书签树 ---');
    console.log(await dumpTree());

    if (MODE === 'repro') {
      // 气泡内相对偏移（像素分析标定，见 02-windows-0.png：516x426）
      const DROP = envOff('DROP', [250, 252]); // 文件夹下拉行
      const DONE = envOff('DONE', [350, 325]); // 完成按钮
      const mainHwnd = listWindows().find((w) => w.size[0] >= 900 && w.title.includes('probe'))?.hwnd;

      startPoll();
      console.log('--- 展开文件夹下拉 ---');
      clickPopup(findPopup(mainHwnd, { titleLike: '已添加到收藏夹' }), DROP);
      await sleep(1200);
      captureAll('03-windows');

      console.log('--- 选择目标文件夹 ---');
      const dd = findPopup(mainHwnd, { excludeTitle: '已添加到收藏夹' }); // 下拉弹层（无标题）
      clickPopup(dd, envOff('ITEM', [120, 90]));
      await sleep(1000);
      captureAll('04-windows');

      console.log('--- 点完成 ---');
      clickPopup(findPopup(mainHwnd, { titleLike: '已添加到收藏夹' }), DONE);
      await sleep(2500);
      captureAll('05-windows');
      await stopPoll();
      console.log('--- 时间线（书签所在文件夹 + URL）---');
      for (const line of trace) console.log('  ' + line);
      const ev = await getSw().then((sw) => sw.evaluate(() => globalThis.__ev || []));
      console.log('--- SW 收到的书签事件 ---');
      for (const line of ev) console.log('  ' + line);
    } else {
      await sleep(2000);
      captureAll('03-windows');
    }

    console.log('--- 结束时的书签树 ---');
    console.log(await dumpTree());
  } finally {
    await context.close().catch(() => {});
    server.close();
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
