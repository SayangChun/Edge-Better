/**
 * EdgeBetter 浏览器集成测试
 *
 * 用 playwright-core 驱动本机 Edge（executablePath），临时 profile + 加载扩展，
 * 通过 CDP Page.navigate / Target.createTarget 模拟书签点击（主框架导航到 newtab@ URL）。
 *
 * 机制（v0.2）：webNavigation.onBeforeNavigate 捕获 newtab@ 书签导航后直接开标签，
 * 并把当前标签导航到"原 URL + fragment"（同文档导航）——当前页不卸载、不刷新、
 * DOM 状态完整保留。无 DNR 规则。
 *
 * 场景：
 *   0. 普通导航不受拦截
 *   1. 空白页（about:blank 模拟 NTP）→ 覆盖当前页，不新增标签   ← 新功能
 *   2. 真实页面 → 新增标签打开书签，原页状态完整保留（不刷新）   ← 用户核心诉求
 *   3. 中键点击（新标签直接带 newtab@ URL 出生）→ 不叠加第二个标签
 *   4. 关闭开关 → newtab@ URL 直接加载（优雅降级），再开启后恢复
 *   5. options 页面可正常打开
 *
 * 注意：测试服务器对每个响应加 SERVER_DELAY_MS 延迟，模拟真实站点的网络往返
 * （书签导航从发起到提交之间有这段窗口，扩展才能及时取消导航保住当前页）。
 *
 * 运行（需要 NODE_PATH 指向受管工作区）：
 *   NODE_PATH="C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/workspace/node_modules" \
 *     "C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe" tools/browser-test.cjs
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const EXT_DIR = 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV = (p) => `http://newtab@127.0.0.1:${PORT}${p}`;
const SERVER_DELAY_MS = 250; // 模拟真实站点往返延迟（扩展取消导航的窗口）

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- 本地测试页服务器 ----
  // 页面脚本记录本次文档是否被卸载过；测试另行设置标记变量与滚动位置。
  // 书签流程结束后若标记/滚动位置仍在，即证明当前页没有被重新加载。
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', BASE);
    const body = `<html><head><title>test ${u.pathname}</title></head><body style="height:3000px"><h1>TESTPAGE ${u.pathname}</h1><script>
window.__navType = performance.getEntriesByType('navigation')[0].type;
window.__unloaded = false;
window.addEventListener('beforeunload', () => { window.__unloaded = true; });
</script></body></html>`;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    }, SERVER_DELAY_MS);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  // ---- 启动 Edge（临时 profile，绝不碰用户真实 profile）----
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgebetter-test-'));
  console.log('profile:', profileDir);
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

  // MV3 Service Worker 空闲会被回收重启：每次用前重新取句柄
  const getSw = async () => {
    for (let i = 0; i < 60; i++) {
      const sws = context.serviceWorkers();
      if (sws.length) return sws[sws.length - 1];
      await sleep(200);
    }
    throw new Error('SW 未找到');
  };

  try {
    const sw0 = await getSw();
    check('扩展 Service Worker 已加载', !!sw0, sw0 ? sw0.url() : '未找到');
    const extId = new URL(sw0.url()).host;
    await sleep(1500); // 等 onInstalled 完成

    const storage = await sw0.evaluate(() => chrome.storage.local.get(null));
    check('默认状态为 enabled', storage && storage.enabled === true, JSON.stringify(storage));

    const page = await context.newPage();

    // ---- 场景 0：普通导航 ----
    await page.goto(`${BASE}/plain`, { waitUntil: 'load' });
    check('普通导航不受拦截', page.url() === `${BASE}/plain`, page.url());

    // ---- 场景 1：空白页 → 覆盖 ----
    await page.goto('about:blank');
    const before1 = context.pages().length;
    const cdp1 = await context.newCDPSession(page);
    await cdp1.send('Page.enable');
    await cdp1.send('Page.navigate', { url: NAV('/blank-test') });
    for (let i = 0; i < 60; i++) {
      if (page.url() === `${BASE}/blank-test`) break;
      await sleep(200);
    }
    await sleep(600);
    check(
      '场景1 空白页点击书签 → 覆盖当前页（标签数不变）',
      context.pages().length === before1 && page.url() === `${BASE}/blank-test`,
      `tabs=${context.pages().length}(before=${before1}) url=${page.url()}`,
    );

    // ---- 场景 2：真实页面 → 新建标签打开书签；原页状态完整保留（不刷新）----
    await page.goto(`${BASE}/pageX`, { waitUntil: 'load' });
    // 在原页上留下状态标记 + 滚动位置：流程后若仍在，即证明文档没有被重新加载
    await page.evaluate(() => {
      window.__marker = 'marker-before-flow';
      window.scrollTo(0, 700);
    });
    const existing2 = new Set(context.pages()); // 快照已有页面（含 Edge 启动页）
    const cdp2 = await context.newCDPSession(page);
    await cdp2.send('Page.enable');
    await cdp2.send('Page.navigate', { url: NAV('/pageY') });
    let newTab = null;
    for (let i = 0; i < 60; i++) {
      const fresh = context.pages().filter((p) => !existing2.has(p));
      if (fresh.length) { newTab = fresh[0]; break; }
      await sleep(200);
    }
    for (let i = 0; i < 40; i++) {
      if (newTab && newTab.url() === `${BASE}/pageY`) break;
      await sleep(200);
    }
    await sleep(1200); // 等当前页的 fragment 取消 + 清理完成
    check(
      '场景2 真实页面点击书签 → 新增标签打开书签',
      !!newTab && newTab.url() === `${BASE}/pageY`,
      newTab ? `newTab=${newTab.url()}` : '新标签未出现',
    );
    // 关键断言（用户诉求）：原页 DOM 状态与滚动位置完整保留，文档未更换。
    // 注意：beforeunload 在导航发起时就会触发（"离开确认"对话框机制），
    // 但本方案中当前页从未被真正卸载——以标记/滚动/导航类型为证。
    const pageState = await page.evaluate(() => ({
      marker: window.__marker,
      scrollY: window.scrollY,
      navType: performance.getEntriesByType('navigation')[0].type,
      unloaded: window.__unloaded,
      url: location.href,
    }));
    check(
      '场景2 原页不刷新（标记/滚动位置保留、文档未更换）',
      pageState.marker === 'marker-before-flow'
        && pageState.scrollY === 700
        && pageState.navType === 'navigate'
        && pageState.url === `${BASE}/pageX`,
      JSON.stringify(pageState),
    );
    if (newTab) await newTab.close().catch(() => {});

    // ---- 场景 3：中键点击模拟（Target.createTarget 直接带 newtab@ URL）----
    const existing3 = new Set(context.pages());
    const before3 = existing3.size;
    const browser = context.browser();
    const bcdp = await browser.newBrowserCDPSession();
    await bcdp.send('Target.createTarget', { url: NAV('/midkey') });
    let midTab = null;
    for (let i = 0; i < 60; i++) {
      const fresh = context.pages().filter((p) => !existing3.has(p));
      if (fresh.length) { midTab = fresh[0]; break; }
      await sleep(200);
    }
    for (let i = 0; i < 40; i++) {
      if (midTab && midTab.url() === `${BASE}/midkey`) break;
      await sleep(200);
    }
    await sleep(600);
    check(
      '场景3 中键点击 → 不叠加第二个标签，书签落在新标签里',
      !!midTab && midTab.url() === `${BASE}/midkey` && context.pages().length === before3 + 1,
      `tabs=${context.pages().length}(before=${before3}) midTab=${midTab ? midTab.url() : 'none'}`,
    );
    if (midTab) await midTab.close().catch(() => {});

    // ---- 场景 6/7：新建书签的加前缀延后到收藏气泡关闭之后 ----
    // 背景：Edge 点星标会立刻在默认文件夹建好书签并弹出收藏气泡，用户在气泡里挑文件夹。
    // 此刻任何对节点的外部改写都会打断这次编辑（用户报告的"选了别的文件夹还是存回原处"）。
    // 所以扩展改为延后加前缀，并在待处理窗口里靠 URL 反查识别"点了这个新书签"。
    const existingC = new Set(context.pages());
    const bcdpC = await context.browser().newBrowserCDPSession();
    await bcdpC.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    let ctl = null;
    for (let i = 0; i < 50; i++) {
      const fresh = context.pages().filter((p) => !existingC.has(p));
      if (fresh.length) { ctl = fresh[0]; break; }
      await sleep(200);
    }
    check('控制页（popup）打开，用作 chrome.bookmarks 通道', !!ctl, ctl ? ctl.url() : '未出现');
    if (ctl) {
      await sleep(800);
      const readBookmarkUrl = async (title) => {
        const tree = await ctl.evaluate(() => chrome.bookmarks.getTree());
        let found = null;
        const walk = (nodes) => {
          for (const n of nodes || []) {
            if (n.title === title) found = n.url;
            if (n.children) walk(n.children);
          }
        };
        walk(tree);
        return found;
      };

      // 场景 6：新建后不立刻改写；切标签（= 气泡必然已关）后补上
      const bm1 = `${BASE}/newbookmark`;
      await ctl.evaluate((url) => chrome.bookmarks.create({ title: 'pending-1', url }), bm1);
      await sleep(1500);
      const stillPlain = await readBookmarkUrl('pending-1');
      check(
        '场景6 新建书签不立刻改写（旧版 800ms 就改了，正好落在收藏气泡里）',
        stillPlain === bm1,
        `url=${stillPlain}`,
      );
      await page.bringToFront(); // 切标签 → 气泡必然已关闭
      await sleep(900);
      const nowPrefixed = await readBookmarkUrl('pending-1');
      check('场景6b 切标签后补上 newtab@ 前缀', nowPrefixed === NAV('/newbookmark'), `url=${nowPrefixed}`);

      // 场景 7：待处理窗口内"点了这个新书签"（导航到它的 URL）→ 走同一套落点逻辑
      await page.goto(`${BASE}/origin2`, { waitUntil: 'load' });
      await page.bringToFront();
      await page.evaluate(() => {
        window.__marker = 'marker-pending';
        window.scrollTo(0, 500);
      });
      const bm2 = `${BASE}/newbookmark2`;
      await ctl.evaluate((url) => chrome.bookmarks.create({ title: 'pending-2', url }), bm2);
      await sleep(400);
      const existing7 = new Set(context.pages());
      const cdp7 = await context.newCDPSession(page);
      await cdp7.send('Page.enable');
      await cdp7.send('Page.navigate', { url: bm2 });
      let tab7 = null;
      for (let i = 0; i < 60; i++) {
        const fresh = context.pages().filter((p) => !existing7.has(p));
        if (fresh.length) { tab7 = fresh[0]; break; }
        await sleep(200);
      }
      for (let i = 0; i < 40; i++) {
        if (tab7 && tab7.url() === `${BASE}/newbookmark2`) break;
        await sleep(200);
      }
      await sleep(1200);
      check(
        '场景7 待处理书签被点击 → 新标签打开（无前缀也认得出）',
        !!tab7 && tab7.url() === `${BASE}/newbookmark2`,
        tab7 ? tab7.url() : '新标签未出现',
      );
      const state7 = await page.evaluate(() => ({
        marker: window.__marker,
        scrollY: window.scrollY,
        url: location.href,
      }));
      check(
        '场景7b 原页仍未被刷新',
        state7.marker === 'marker-pending' && state7.scrollY === 500 && state7.url === `${BASE}/origin2`,
        JSON.stringify(state7),
      );
      await sleep(600);
      const bm2Url = await readBookmarkUrl('pending-2');
      check('场景7c 点击后补上 newtab@ 前缀', bm2Url === NAV('/newbookmark2'), `url=${bm2Url}`);
      if (tab7) await tab7.close().catch(() => {});
      await ctl.close().catch(() => {});
    }

    // ---- 场景 4：开关关闭 → 优雅降级；再开启 → 恢复 ----
    // 注意：MV3 SW 空闲约 30s 即被回收，直接 evaluate 旧句柄会失败；
    // 改走扩展自己的弹窗页发消息（消息会唤醒 SW）。
    const existing4 = new Set(context.pages());
    const bcdp4 = await context.browser().newBrowserCDPSession();
    await bcdp4.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    let popup = null;
    for (let i = 0; i < 50; i++) {
      const fresh = context.pages().filter((p) => !existing4.has(p));
      if (fresh.length) { popup = fresh[0]; break; }
      await sleep(200);
    }
    check('弹窗页可作为控制通道打开', !!popup && popup.url().includes('popup.html'), popup ? popup.url() : '未出现');
    if (popup) {
      await sleep(800);
      await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'setEnabled', value: false }));
      await sleep(500);
      await page.goto('about:blank');
      const before4 = context.pages().length;
      const cdp4 = await context.newCDPSession(page);
      await cdp4.send('Page.enable');
      await cdp4.send('Page.navigate', { url: NAV('/degraded') });
      let degradedText = '';
      for (let i = 0; i < 60; i++) {
        degradedText = await page.textContent('h1').catch(() => '');
        if (degradedText.includes('/degraded')) break;
        await sleep(200);
      }
      await sleep(500);
      // 注意：关闭后 Edge 地址栏仍会显示带 newtab@ 的 URL（userinfo 外观问题），
      // 但页面能正常加载——以页面内容为准，不以 URL 字符串为准。
      check(
        '场景4 关闭后 newtab@ URL 直接加载（userinfo 被忽略，优雅降级）',
        degradedText.includes('TESTPAGE /degraded') && context.pages().length === before4,
        `tabs=${context.pages().length}(before=${before4}) h1=${degradedText}`,
      );
      await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'setEnabled', value: true }));
      await sleep(500);
      // 重新开启后书签导航必须恢复（空白页覆盖）
      await page.goto('about:blank');
      const before4b = context.pages().length;
      const cdp4b = await context.newCDPSession(page);
      await cdp4b.send('Page.enable');
      await cdp4b.send('Page.navigate', { url: NAV('/after-reenable') });
      for (let i = 0; i < 60; i++) {
        if (page.url() === `${BASE}/after-reenable`) break;
        await sleep(200);
      }
      await sleep(400);
      check(
        '场景4b 重新开启后书签导航恢复（空白页覆盖）',
        page.url() === `${BASE}/after-reenable` && context.pages().length === before4b,
        `tabs=${context.pages().length}(before=${before4b}) url=${page.url()}`,
      );
      await popup.close();
    }

    // ---- 场景 5：options 页面 ----
    try {
      const existing5 = new Set(context.pages());
      const bcdp5 = await context.browser().newBrowserCDPSession();
      await bcdp5.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
      let optPage = null;
      for (let i = 0; i < 50; i++) {
        const fresh = context.pages().filter((p) => !existing5.has(p));
        if (fresh.length) { optPage = fresh[0]; break; }
        await sleep(200);
      }
      if (optPage) {
        await sleep(800);
        const text = await optPage.textContent('body');
        check('options 页面可打开', text && text.includes('EdgeBetter 设置'), (text || '').slice(0, 60));
        await optPage.close();
      } else {
        check('options 页面可打开', false, '页面未出现');
      }
    } catch (e) {
      check('options 页面可打开', false, String(e).slice(0, 120));
    }
  } finally {
    await context.close().catch(() => {});
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(' -', f.name);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(2);
});
