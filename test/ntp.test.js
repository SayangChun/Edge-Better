import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlankPage, builtinBlankPatterns } from '../lib/ntp.js';
import { decideAction } from '../lib/decision.js';

test('内置空白页变体全部命中', () => {
  for (const url of [
    'edge://newtab/',
    'edge://newtab',
    'about:newtab',
    'chrome://newtab/',
    'about:blank',
    'https://ntp.msn.com/edge/ntp',
    'https://www.msn.cn/spartan/ntp?locale=zh-CN',
  ]) {
    assert.equal(isBlankPage(url), true, `应判为空白: ${url}`);
  }
});

test('空/未定义 URL 视为空白（刚创建的标签页）', () => {
  assert.equal(isBlankPage(''), true);
  assert.equal(isBlankPage(undefined), true);
  assert.equal(isBlankPage(null), true);
});

test('真实页面不判为空白', () => {
  for (const url of [
    'https://example.com/',
    'https://www.bilibili.com/video/BV1xx',
    'http://localhost:3000/admin',
  ]) {
    assert.equal(isBlankPage(url), false, `不应判为空白: ${url}`);
  }
});

test('用户自定义空白页模式生效', () => {
  assert.equal(isBlankPage('https://momentumdash.com/app', ['^https://momentumdash\\.com/']), true);
  assert.equal(isBlankPage('https://other.com/', ['^https://momentumdash\\.com/']), false);
});

test('非法自定义正则被静默忽略', () => {
  assert.equal(isBlankPage('https://example.com/', ['([unclosed']), false);
});

test('内置模式可导出展示', () => {
  const list = builtinBlankPatterns();
  assert.ok(list.length >= 5);
  assert.ok(list.some((s) => s.includes('edge')));
});

test('决策：空白新标签页 → 覆盖', () => {
  assert.equal(decideAction({ prevUrl: 'edge://newtab/' }), 'override');
  assert.equal(decideAction({ prevUrl: 'about:blank' }), 'override');
  assert.equal(decideAction({ prevUrl: undefined }), 'override');
  assert.equal(decideAction({ prevUrl: '' }), 'override');
});

test('决策：为书签新建的标签页（中键点击）→ 覆盖', () => {
  assert.equal(decideAction({ prevUrl: 'https://example.com/', createdForBookmark: true }), 'override');
});

test('决策：真实页面 → 新建标签 + 恢复', () => {
  assert.equal(decideAction({ prevUrl: 'https://example.com/' }), 'create-restore');
  assert.equal(decideAction({ prevUrl: 'https://example.com/', createdForBookmark: false }), 'create-restore');
});

test('决策：自定义空白模式', () => {
  assert.equal(
    decideAction({ prevUrl: 'https://momentumdash.com/app', extraBlankPatterns: ['^https://momentumdash\\.com/'] }),
    'override',
  );
});
