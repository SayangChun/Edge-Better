/**
 * Edge Better —— 无调试器真机测试台
 *
 * 为什么需要它：Playwright/CDP 附着会让 Edge **不回收 Service Worker**
 * （官方文档：Chrome 118 起调试器会话保活 SW），也会禁用 bfcache。
 * 任何基于 CDP 的测试都会系统性掩盖「SW 冷启动」这类问题。
 * 所以这里：child_process 直接启动独立 Edge（临时 profile + 加载扩展），**不接调试器**，
 * 测试页自己把"文档身份"汇报给本地服务器，事后只看服务器日志。
 *
 * 一次运行只跑一个场景（避免场景之间互相污染：扩展会新开标签并激活，
 * 原标签转后台后可能被冻结，导致后续命令收不到）。
 *
 * MODE：
 *   race-warm  启动后立刻触发 newtab@ 导航（SW 热）
 *   race-cold  静置 IDLE_MS 后触发（SW 已被空闲回收）——复现「点书签刷新当前页」
 *   bfcache    原页导航到 /middle，/middle 立刻 history.back()，看原页是否被 bfcache 恢复
 *   bfcache-ext 同上，但中间页换成扩展页（DNR + 落地页方案的可行性判据）
 *
 * 运行：NODE_PATH="..." "…/node.exe" tools/harness-real.cjs
 *   MODE=race-cold IDLE_MS=60000 ...
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const EXT_DIR = process.env.EXT_DIR || 'E:/project/EdgeBetter';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.PORT || 8915);
const BASE = `http://127.0.0.1:${PORT}`;
const MODE = process.env.MODE || 'race-cold';
const IDLE_MS = Number(process.env.IDLE_MS || 60000);

const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => { log.push(s); console.log(s); };

/**
 * 测试页：不带 beforeunload / unload（那会禁用 bfcache）。
 * poll=true 的页面会轮询 /cmd，收到 go 就导航到指令给的 URL（模拟"点书签"）。
 * back=true 的页面加载后立刻 history.back()（模拟"落地页立刻回退"）。
 */
const PAGE = (title, opts = {}) => `<html><head><title>${title}</title></head><body style="height:3000px"><h1>${title}</h1>
<script>
var docId = Math.random().toString(36).slice(2);
function report(ev, extra) {
  var q = '/report?path=' + encodeURIComponent(location.pathname) + '&doc=' + docId +
          '&ev=' + ev + '&t=' + Date.now() + '&u=' + encodeURIComponent(location.href) + (extra || '');
  if (navigator.sendBeacon) navigator.sendBeacon(q); else fetch(q, { keepalive: true });
}
window.addEventListener('pageshow', function (e) { report('pageshow', '&persisted=' + e.persisted); });
window.addEventListener('pagehide', function (e) { report('pagehide', '&persisted=' + e.persisted); });
report('load');
${opts.back ? "setTimeout(function(){ history.back(); }, 30);" : ''}
${opts.poll ? `setInterval(function () {
  fetch('/cmd').then(function (r) { return r.json(); }).then(function (c) {
    if (c && c.go) { report('go'); location.href = c.url; }
  }).catch(function () {});
}, 250);` : ''}
</script></body></html>`;

async function main() {
  let go = false;
  let goUrl = '';

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, BASE);
    if (u.pathname === '/report') {
      say(`${Date.now()} REPORT ${u.searchParams.get('path')} doc=${u.searchParams.get('doc')} ev=${u.searchParams.get('ev')}` +
        (u.searchParams.get('persisted') !== null ? ` persisted=${u.searchParams.get('persisted')}` : '') +
        (u.searchParams.get('u') ? ` u=${u.searchParams.get('u')}` : ''));
      res.writeHead(204).end();
      return;
    }
    if (u.pathname === '/diag') { say('  DIAG ' + u.searchParams.get('m')); res.writeHead(204).end(); return; }
    if (u.pathname === '/cmd') {
      const reply = { go, url: goUrl };
      if (go) go = false; // 一次性：避免页面反复触发
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
      return;
    }
    say(`${Date.now()} GET ${u.pathname}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE('PAGE ' + u.pathname, {
      poll: u.pathname === '/origin',
      back: u.pathname === '/middle',
    }));
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-better-harness-'));
  console.log(`MODE=${MODE}  profile=${profileDir}  IDLE_MS=${IDLE_MS}`);

  const edge = spawn(EDGE, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-position=80,60',
    '--window-size=1200,800',
    `${BASE}/origin`,
    '--enable-logging=stderr',
    '--v=0',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // 收集 Edge 的 stderr：MV3 SW 的 console.warn/error 会进这里
  const errBuf = [];
  edge.stderr.on('data', (d) => errBuf.push(d.toString()));

  const originLoads = () => log.filter((l) => /REPORT \/origin .* ev=load/.test(l)).map((l) => /doc=(\w+)/.exec(l)[1]);
  const originRestores = () => log.filter((l) => /REPORT \/origin .* ev=pageshow.*persisted=true/.test(l));
  const hits = (p) => log.filter((l) => l.includes(`GET ${p}`)).length;
  const targetLoads = () => log.filter((l) => /REPORT \/target .* ev=load/.test(l)).length;
  const originHides = () => log.filter((l) => /REPORT \/origin .* ev=pagehide/.test(l));

  try {
    console.log('--- 等浏览器起来 + 扩展安装 ---');
    await sleep(9000);
    const loadsBefore = originLoads().length;
    const middleBefore = hits('/middle');
    const targetBefore = hits('/target');

    if (MODE === 'race-cold') {
      console.log(`--- 静置 ${IDLE_MS / 1000}s，让 SW 被空闲回收 ---`);
      await sleep(IDLE_MS);
    }

    // CLICK_FIRST=1：先真实点一下页面制造 sticky user activation。
    // 这条开关是给 beforeunload / bfcache 资格实验用的 —— 两者都只在
    // 「用户交互过」时才生效，而 CDP 合成的点击不能用（CDP 本身禁用 bfcache）。
    if (process.env.CLICK_FIRST === '1') {
      const py = process.env.PYTHON ||
        'C:/Users/ZenithChunyang/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe';
      console.log('--- 真实点击页面（制造 user activation）---');
      try {
        // 必须按测试页标题匹配，否则会点到用户自己开着的 Edge 窗口
        execFileSync(py, [path.join(__dirname, 'click-center.py'), 'PAGE /origin'], {
          stdio: 'inherit',
        });
      } catch (e) {
        console.log('  点击失败:', e.message);
      }
      await sleep(1200);
    }

    if (MODE === 'bfcache') {
      // 原页 → 中间页（加载后立刻 history.back()）→ 看原页是 bfcache 恢复还是重新加载。
      // 这是"DNR 重定向到落地页 + history.back()"方案可行性的判据：
      // bfcache 生效 = 原页被冻结-恢复，用户看不到重载。
      goUrl = `${BASE}/middle`;
      go = true;
      await sleep(4000);
      go = false;
      const loads = originLoads();
      console.log(`\n  原页 load 次数: ${loadsBefore} → ${loads.length}（新增=${loads.length - loadsBefore}）`);
      console.log(`  原页 bfcache 恢复次数: ${originRestores().length}`);
      console.log(`  /middle 请求数: ${middleBefore} → ${hits('/middle')}`);
      const restored = originRestores().length > 0;
      console.log(`  结论：原页${restored ? '被 bfcache 恢复（无刷新）✓' : '被重新加载（刷新）✗'}`);
    } else {
      goUrl = `http://newtab@127.0.0.1:${PORT}/target`;
      const tBeforeFire = hits('/target');
      go = true;
      await sleep(3000);
      go = false;
      if (hits('/target') === tBeforeFire) {
        // 偶发：页面没发起导航（测试台自身抖动），重试一次
        console.log('  (未观察到导航请求，重试一次)');
        await sleep(1500);
        go = true;
        await sleep(3000);
        go = false;
      }
      const loads = originLoads();
      const newDocs = loads.slice(loadsBefore);
      const tLoads = targetLoads();
      const hides = originHides();
      console.log(`\n  原页 load 次数: ${loadsBefore} → ${loads.length}（新增 docId=${JSON.stringify(newDocs)}）`);
      console.log(`  /target 请求数: ${targetBefore} → ${hits('/target')}；/target 实际加载次数: ${tLoads}`);
      console.log(`  原页 pagehide: ${hides.length} 次 ${JSON.stringify(hides.map((l) => /persisted=(\w+)/.exec(l)?.[1]))}`);
      const reloaded = loads.length > loadsBefore;
      const opened = tLoads > 0;
      const restored = originRestores().length > 0;
      const leftButRestored = hides.length > 0 && restored; // 被顶掉但 bfcache 恢复 = 无害
      const hijacked = (tLoads > 1 || hides.length > 0) && !leftButRestored;
      console.log(`  结论：原页${reloaded ? '被重新加载（刷新）✗' : '未被重新加载 ✓'}` +
        `${leftButRestored ? '（曾离开，已由 bfcache 无损恢复 ✓）' : ''}；` +
        `当前标签${hijacked ? '被书签页顶掉 ✗' : '保持 ✓'}；新标签${opened ? '已打开 ✓' : '未打开 ✗'}`);
    }
    console.log('\n--- 扩展/浏览器 stderr（过滤 Edge Better 相关）---');
    const errHits = errBuf.join('').split('\n').filter((l) => /Edge Better|Unchecked runtime|goBack|Cannot/i.test(l));
    console.log(errHits.length ? errHits.slice(-25).join('\n') : '(无相关输出)');
  } finally {
    edge.kill();
    await sleep(1500);
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
}

main().catch((e) => {
  console.error('测试台异常：', e);
  process.exit(2);
});
