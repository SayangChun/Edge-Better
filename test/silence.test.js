/**
 * Edge Better —— 「取消导航时的页面静默」防漂移测试
 *
 * 背景：点书签时当前标签会被浏览器导航到 https://newtab@target，扩展只能用
 * 「导航到 原URL + #edge-better」把它取消掉。这次同文档导航会触发
 * popstate + hashchange，SPA 直播站会当成路由变化重新渲染、把播放器暂停
 * （v0.3.1 修的 bug）。静默靠 cs/guard.js 在捕获阶段吞掉这些事件。
 *
 * guard 里的标记必须与 background.js 的 RESTORE_FRAGMENT 完全一致，
 * 且必须在 manifest 里、排在页面任何脚本之前注入。这三条一旦漂移，
 * bug 会静默复发（测试全绿、直播照样暂停），所以单独锁住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('guard 的静默标记包含 background 的 RESTORE_FRAGMENT 及其碰撞兜底', () => {
  const bg = read('background.js');
  const m = /const RESTORE_FRAGMENT = '([^']+)'/.exec(bg);
  assert.ok(m, 'background.js 里找不到 RESTORE_FRAGMENT');
  const frag = m[1];

  const guard = read('cs/guard.js');
  const markers = /const MARKERS = \[([^\]]+)\]/.exec(guard);
  assert.ok(markers, 'cs/guard.js 里找不到 MARKERS');

  const list = [...markers[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(list.includes(frag), `MARKERS 缺少 ${frag}`);
  assert.ok(list.includes(frag + '2'), `MARKERS 缺少碰撞兜底 ${frag}2`);
});

test('manifest 注册了 guard 且在 zoom 之前注入（更早注册捕获监听器）', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const cs = manifest.content_scripts || [];
  const entry = cs.find((c) => (c.js || []).includes('cs/guard.js'));
  assert.ok(entry, 'manifest 未注册 cs/guard.js');
  assert.equal(entry.run_at, 'document_start', 'guard 必须 document_start 注入');
  assert.equal(entry.all_frames, false, 'guard 只需顶层文档');

  const js = entry.js;
  assert.ok(
    js.indexOf('cs/guard.js') < js.indexOf('cs/zoom.js'),
    'guard 应排在 zoom 之前（保证捕获监听器先注册）',
  );
  const matches = entry.matches || [];
  assert.ok(matches.includes('http://*/*') && matches.includes('https://*/*'),
    'guard 需覆盖 http(s) 页面');
});

test('guard 用捕获阶段监听 popstate / hashchange 并阻止后续监听器', () => {
  const guard = read('cs/guard.js');
  for (const ev of ['popstate', 'hashchange']) {
    const re = new RegExp(`addEventListener\\('${ev}',\\s*silence,\\s*true\\)`);
    assert.ok(re.test(guard), `guard 未在捕获阶段监听 ${ev}`);
  }
  assert.ok(/stopImmediatePropagation\(\)/.test(guard),
    'guard 必须 stopImmediatePropagation，否则页面监听器照样执行');
});
