import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAction, navState } from '../lib/decision.js';

/* ---------------- decideAction ---------------- */

test('空白页 / 为书签新建的标签 → 覆盖当前页', () => {
  assert.equal(decideAction({ prevUrl: 'about:blank' }), 'override');
  assert.equal(decideAction({ prevUrl: 'edge://newtab/' }), 'override');
  assert.equal(decideAction({ prevUrl: 'https://example.com/x', createdForBookmark: true }), 'override');
});

test('普通页面 → 新建标签 + 恢复原页', () => {
  assert.equal(decideAction({ prevUrl: 'https://example.com/x' }), 'create-restore');
  assert.equal(decideAction({ prevUrl: 'https://momentumdash.com/' }), 'create-restore');
  assert.equal(
    decideAction({ prevUrl: 'https://momentumdash.com/', extraBlankPatterns: ['^https://momentumdash\\.com/'] }),
    'override',
  );
});

/* ---------------- navState ---------------- */

const TARGET = 'https://example.com/b';

test('还停在原页 → pending（用同文档导航取消）', () => {
  assert.equal(navState({ prevUrl: 'https://example.com/a', curUrl: 'https://example.com/a', target: TARGET }), 'pending');
});

test('已经变成书签目标页 → hijacked（回退恢复，不能整页重载）', () => {
  assert.equal(navState({ prevUrl: 'https://example.com/a', curUrl: TARGET, target: TARGET }), 'hijacked');
});

test('提交后仍带 newtab@ 标记 → hijacked', () => {
  assert.equal(
    navState({ prevUrl: 'https://example.com/a', curUrl: 'https://newtab@example.com/b', target: TARGET }),
    'hijacked',
  );
});

test('用户点的就是当前页的书签 → 仍是 pending（同文档取消是安全的）', () => {
  assert.equal(navState({ prevUrl: TARGET, curUrl: TARGET, target: TARGET }), 'pending');
});

test('信息不足 / 页面自己改了 hash → 按 pending 处理', () => {
  assert.equal(navState({ prevUrl: undefined, curUrl: TARGET, target: TARGET }), 'pending');
  assert.equal(navState({ prevUrl: 'https://example.com/a', curUrl: undefined, target: TARGET }), 'pending');
  assert.equal(
    navState({ prevUrl: 'https://example.com/a', curUrl: 'https://example.com/a#section', target: TARGET }),
    'pending',
  );
});
