/**
 * EdgeBetter 浏览器集成测试
 *
 * 用 playwright-core 驱动本机 Edge（executablePath），临时 profile + 加载扩展，
 * 通过 CDP Page.navigate / Target.createTarget 模拟书签点击（主框架导航到 newtab@ URL）。
 *
 * 场景：
 *   0. 普通导航不受拦截
 *   1. 空白页（about:blank 模拟 NTP）→ 覆盖当前页，不新增标签   ← 新功能
 *   2. 真实页面 → 新增标签打开书签，原页面恢复                    ← 核心机制 + DNR 生效验证
 *   3. 中键点击（新标签直接带 newtab@ URL 出生）→ 不再叠加第二个标签
 *   4. 关闭开关 → newtab@ URL 直接加载（优雅降级），再开启后恢复
 *   5. options 页面可正常打开
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

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- 本地测试页服务器 ----
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', BASE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>test ${u.pathname}</title></head><body><h1>TESTPAGE ${u.pathname}</h1></body></html>`);
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
    await sleep(1500); // 等 onInstalled 完成（DNR 规则注册）

    // 直接读扩展内部状态
    const rules = await sw0.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    check('DNR 动态规则已注册', Array.isArray(rules) && rules.length === 1, JSON.stringify(rules));
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
    const nav1 = await cdp1.send('Page.navigate', { url: NAV('/blank-test') });
    for (let i = 0; i < 40; i++) {
      if (page.url() === `${BASE}/blank-test`) break;
      await sleep(200);
    }
    await sleep(600);
    check(
      '场景1 空白页点击书签 → 覆盖当前页（标签数不变）',
      context.pages().length === before1 && page.url() === `${BASE}/blank-test`,
      `tabs=${context.pages().length}(before=${before1}) url=${page.url()} navErr=${nav1.errorText || 'none'}`,
    );

    // ---- 场景 2：真实页面 → 新建标签 + 原页恢复（DNR 生效的判别场景）----
    await page.goto(`${BASE}/pageX`, { waitUntil: 'load' });
    const existing2 = new Set(context.pages()); // 快照已有页面（含 Edge 启动页）
    const before2 = existing2.size;
    const cdp2 = await context.newCDPSession(page);
    await cdp2.send('Page.enable');
    await cdp2.send('Page.navigate', { url: NAV('/pageY') });
    let newTab = null;
    for (let i = 0; i < 50; i++) {
      const fresh = context.pages().filter((p) => !existing2.has(p));
      if (fresh.length) { newTab = fresh[0]; break; }
      await sleep(200);
    }
    for (let i = 0; i < 30; i++) {
      if (newTab && newTab.url() === `${BASE}/pageY`) break;
      await sleep(200);
    }
    await sleep(800);
    check(
      '场景2 真实页面点击书签 → 新增标签打开书签',
      !!newTab && newTab.url() === `${BASE}/pageY`,
      newTab ? `newTab=${newTab.url()}` : '新标签未出现',
    );
    check(
      '场景2 原页面被恢复（history.back）',
      page.url() === `${BASE}/pageX`,
      `oldTab=${page.url()}`,
    );
    if (newTab) await newTab.close().catch(() => {});

    // ---- 场景 3：中键点击模拟（Target.createTarget 直接带 newtab@ URL）----
    const existing3 = new Set(context.pages());
    const before3 = existing3.size;
    const browser = context.browser();
    const bcdp = await browser.newBrowserCDPSession();
    await bcdp.send('Target.createTarget', { url: NAV('/midkey') });
    let midTab = null;
    for (let i = 0; i < 50; i++) {
      const fresh = context.pages().filter((p) => !existing3.has(p));
      if (fresh.length) { midTab = fresh[0]; break; }
      await sleep(200);
    }
    for (let i = 0; i < 30; i++) {
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

    // ---- 场景 4：开关关闭 → 优雅降级；再开启 → 恢复 ----
    // 注意：MV3 SW 空闲约 30s 即被回收，直接 evaluate 旧句柄会失败；
    // 改走扩展自己的弹窗页发消息（消息会唤醒 SW），并从弹窗页读 DNR 规则。
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
      const rulesOff = await popup.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      check('关闭后 DNR 规则被移除', rulesOff.length === 0, `rules=${rulesOff.length}`);
      await page.goto('about:blank');
      const before4 = context.pages().length;
      const cdp4 = await context.newCDPSession(page);
      await cdp4.send('Page.enable');
      await cdp4.send('Page.navigate', { url: NAV('/degraded') });
      let degradedText = '';
      for (let i = 0; i < 40; i++) {
        degradedText = await page.textContent('h1').catch(() => '');
        if (degradedText.includes('/degraded')) break;
        await sleep(200);
      }
      await sleep(500);
      // 注意：关闭拦截后 Edge 地址栏仍会显示带 newtab@ 的 URL（userinfo 外观问题），
      // 但页面能正常加载——以页面内容为准，不以 URL 字符串为准。
      check(
        '场景4 关闭后 newtab@ URL 直接加载（userinfo 被忽略，优雅降级）',
        degradedText.includes('TESTPAGE /degraded') && context.pages().length === before4,
        `tabs=${context.pages().length}(before=${before4}) h1=${degradedText} urlBar=${page.url()}`,
      );
      await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'setEnabled', value: true }));
      await sleep(500);
      const rulesOn = await popup.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
      check('重新开启后规则恢复', rulesOn.length === 1, `rules=${rulesOn.length}`);
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
