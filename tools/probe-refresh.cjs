/**
 * Edge Better —— 「当前页被刷新」复现探针（一次性验证脚本）
 *
 * 目的：查清为什么点击书签时当前页会刷新。两种触发方式对比：
 *   A. CDP Page.navigate（渲染进程发起，旧测试用的方式）
 *   B. chrome.tabs.update（浏览器进程发起，最接近收藏夹栏点击）
 * 服务器响应延迟由 DELAY 环境变量控制：DELAY=0 时站点秒回，
 * 扩展"先 tabs.create 再 tabs.update 取消导航"的窗口会被吃掉 → 复现刷新。
 *
 * 运行：
 *   NODE_PATH="C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/workspace/node_modules" \
 *     "C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe" tools/probe-refresh.cjs
 *   DELAY=250 ... tools/probe-refresh.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8911;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV = (p) => `http://newtab@127.0.0.1:${PORT}${p}`;
const DELAY = Number(process.env.DELAY || 0);

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '\n        ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = (title) => `<html><head><title>${title}</title></head><body style="height:3000px"><h1>${title}</h1>
<script>
window.__docId = Math.random().toString(36).slice(2);
window.__marker = null;
window.__unloaded = false;
window.addEventListener('beforeunload', () => { window.__unloaded = true; });
window.__navType = performance.getEntriesByType('navigation')[0].type;
</script></body></html>`;

async function main() {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE('PAGE ' + (req.url || '/')));
    }, DELAY);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-refresh-'));
  console.log(`profile: ${profileDir}  服务器延迟: ${DELAY}ms`);
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: EDGE,
    headless: true,
    args: [
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
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

  try {
    const sw = await getSw();
    const extId = new URL(sw.url()).host;
    await sleep(1500);

    // 控制通道：扩展自己的 popup 页（可调 chrome.tabs / webNavigation）
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
    await sleep(800);
    // 在 popup 里挂 webNavigation 时间线，用于测量"发起 → 提交"的窗口
    await popup.evaluate(() => {
      window.__events = [];
      const push = (type) => (d) => {
        if (d.frameId === 0 && /newtab@/.test(d.url)) window.__events.push({ type, t: Math.round(performance.now()), url: d.url });
      };
      chrome.webNavigation.onBeforeNavigate.addListener(push('beforeNavigate'));
      chrome.webNavigation.onCommitted.addListener(push('committed'));
    });

    const page = await context.newPage();
    await page.goto(`${BASE}/warmup`, { waitUntil: 'load' });

    const originTabId = async () => {
      const tabs = await popup.evaluate(() => chrome.tabs.query({}));
      const t = tabs.find((x) => (x.url || '').startsWith(BASE + '/origin'));
      if (!t) throw new Error('找不到 origin 标签页：' + JSON.stringify(tabs.map((x) => x.url)));
      return t.id;
    };

    const scenario = async (label, trigger) => {
      await popup.evaluate(() => { window.__events = []; });
      await page.goto(`${BASE}/origin`, { waitUntil: 'load' });
      await page.evaluate(() => { window.__marker = 'M'; window.scrollTo(0, 700); });
      const before = await page.evaluate(() => ({ docId: window.__docId, marker: window.__marker, scrollY: window.scrollY, url: location.href }));
      const beforeTabs = context.pages().length;
      const beforePages = new Set(context.pages());

      await trigger();

      let newTab = null;
      for (let i = 0; i < 60; i++) {
        const fresh = context.pages().filter((p) => !beforePages.has(p));
        if (fresh.length) { newTab = fresh[0]; break; }
        await sleep(200);
      }
      for (let i = 0; i < 40; i++) {
        if (newTab && /\/bookmark-target/.test(newTab.url())) break;
        await sleep(200);
      }
      await sleep(1500); // 等 fragment 取消 + replaceState 清理完成

      const after = await page.evaluate(() => ({
        docId: window.__docId,
        marker: window.__marker,
        scrollY: window.scrollY,
        navType: window.__navType,
        unloaded: window.__unloaded,
        url: location.href,
      })).catch((e) => ({ error: String(e).slice(0, 80) }));
      const events = await popup.evaluate(() => window.__events);
      const gap = (() => {
        const b = events.find((e) => e.type === 'beforeNavigate');
        const c = events.find((e) => e.type === 'committed');
        return b && c ? `${c.t - b.t}ms` : '(未提交)';
      })();

      console.log(`\n--- ${label} ---`);
      console.log('  事件:', JSON.stringify(events));
      console.log('  发起→提交窗口:', gap);
      console.log('  原页 before:', JSON.stringify(before));
      console.log('  原页 after :', JSON.stringify(after));
      console.log('  新标签:', newTab ? newTab.url() : '未出现', ' 标签数:', `${context.pages().length}(before=${beforeTabs})`);

      check(
        `${label} 新标签打开了书签`,
        !!newTab && /\/bookmark-target/.test(newTab.url()),
        newTab ? newTab.url() : '未出现',
      );
      check(
        `${label} 原页未被刷新（DOM 状态保留）`,
        after.docId === before.docId && after.marker === 'M' && after.scrollY === 700 && after.url === `${BASE}/origin`,
        JSON.stringify(after),
      );
      if (newTab) await newTab.close().catch(() => {});
    };

    // A. 渲染进程发起（CDP Page.navigate，旧测试的模拟方式）
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    await scenario('A 渲染进程发起导航', async () => {
      await cdp.send('Page.navigate', { url: NAV('/bookmark-target') });
    });

    // B. 浏览器进程发起（chrome.tabs.update，最接近收藏夹栏点击）
    await scenario('B 浏览器进程发起导航', async () => {
      const id = await originTabId();
      await popup.evaluate(({ id, url }) => chrome.tabs.update(id, { url, active: true }), {
        id,
        url: NAV('/bookmark-target'),
      });
    });
  } finally {
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    for (const f of failed) console.log(' -', f.name);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
