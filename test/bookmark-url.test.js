import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrefixed, isRewriteable, addPrefix, removePrefix } from '../lib/bookmark-url.js';

test('addPrefix 保留原 scheme', () => {
  assert.equal(addPrefix('https://example.com/a'), 'https://newtab@example.com/a');
  assert.equal(addPrefix('http://example.com/a'), 'http://newtab@example.com/a');
});

test('removePrefix 恢复原始 URL（含 scheme）', () => {
  assert.equal(removePrefix('https://newtab@example.com/a'), 'https://example.com/a');
  assert.equal(removePrefix('http://newtab@example.com/a'), 'http://example.com/a');
});

test('加/去前缀往返一致', () => {
  for (const url of [
    'https://example.com',
    'https://example.com/path?q=1&b=2#frag',
    'http://a.b.c.d:8080/x',
    'https://sub.domain.example.co.uk/deep/path?x=%20y',
  ]) {
    const round = removePrefix(addPrefix(url));
    assert.equal(round, url, `往返失败: ${url}`);
  }
});

test('幂等：已带前缀不再叠加', () => {
  assert.equal(addPrefix('https://newtab@example.com'), null);
});

test('removePrefix 每次只剥一层前缀', () => {
  // 双重前缀只会来自用户手动编辑；剥一层后剩余仍是合法的前缀形态
  assert.equal(
    removePrefix('https://newtab@https://newtab@example.com'),
    'https://https://newtab@example.com',
  );
});

test('非 http(s) 一律不改写', () => {
  for (const url of [
    'javascript:void(0)',
    'edge://newtab/',
    'chrome://bookmarks/',
    'file:///C:/x.html',
    'data:text/html,hi',
    'about:blank',
  ]) {
    assert.equal(addPrefix(url), null, `不应改写: ${url}`);
    assert.equal(isRewriteable(url), false);
  }
});

test('isPrefixed 大小写不敏感', () => {
  assert.equal(isPrefixed('HTTPS://newtab@example.com'), true);
  assert.equal(isPrefixed('https://example.com'), false);
  assert.equal(isPrefixed(undefined), false);
});

test('含 query/fragment 的 URL 前缀不影响 removePrefix', () => {
  const url = 'https://example.com/s?q=a&b=1#sec';
  const prefixed = addPrefix(url);
  assert.equal(removePrefix(prefixed), url);
});
