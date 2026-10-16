import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPendingByUrl } from '../lib/pending.js';

const pending = {
  7: { url: 'https://example.com/a', at: 1, tabId: 3 },
  9: { url: 'http://localhost:3000/x', at: 2, tabId: 4 },
};

test('按 URL 命中待处理书签', () => {
  assert.equal(findPendingByUrl(pending, 'https://example.com/a'), '7');
  assert.equal(findPendingByUrl(pending, 'http://localhost:3000/x'), '9');
});

test('未命中返回 null', () => {
  assert.equal(findPendingByUrl(pending, 'https://example.com/b'), null);
  // 带 newtab@ 前缀的 URL 属于"已改写"通道，不该在这里命中
  assert.equal(findPendingByUrl(pending, 'https://newtab@example.com/a'), null);
});

test('空表 / 异常输入不抛错', () => {
  assert.equal(findPendingByUrl({}, 'https://example.com/a'), null);
  assert.equal(findPendingByUrl(null, 'https://example.com/a'), null);
  assert.equal(findPendingByUrl(pending, undefined), null);
  assert.equal(findPendingByUrl({ 1: null }, 'https://example.com/a'), null);
});
