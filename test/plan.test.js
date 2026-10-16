import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPrefixUpdates, countPrefixed } from '../lib/plan.js';

const tree = [
  {
    id: '1',
    children: [
      { id: '10', title: '书签栏', children: [
        { id: '100', title: 'Bing', url: 'https://www.bing.com/' },
        { id: '101', title: '本地', url: 'http://localhost:3000/x' },
        { id: '102', title: '脚本', url: 'javascript:alert(1)' },
        { id: '103', title: '已改写', url: 'https://newtab@example.com/already' },
      ] },
      { id: '11', title: '文件夹', children: [
        { id: '110', title: '嵌套', url: 'https://example.com/deep?a=1' },
      ] },
    ],
  },
];

test('enable 计划：仅 http(s)、未改写书签', () => {
  const ops = planPrefixUpdates(tree, 'enable');
  assert.equal(ops.length, 3);
  assert.deepEqual(
    ops.map((o) => o.id).sort(),
    ['100', '101', '110'],
  );
  assert.equal(ops.find((o) => o.id === '100').to, 'https://newtab@www.bing.com/');
  assert.equal(ops.find((o) => o.id === '101').to, 'http://newtab@localhost:3000/x');
});

test('disable 计划：仅已改写书签', () => {
  const ops = planPrefixUpdates(tree, 'disable');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].id, '103');
  assert.equal(ops[0].to, 'https://example.com/already');
});

test('二次 enable 幂等（无操作）', () => {
  const twice = planPrefixUpdates(tree, 'enable').map((o) => ({ ...o, to: o.to }));
  const again = planPrefixUpdates([
    { id: '1', children: [{ id: '100', url: twice[0].to }] },
  ], 'enable');
  assert.equal(again.length, 0);
});

test('countPrefixed 统计', () => {
  assert.equal(countPrefixed(tree), 1);
  assert.equal(countPrefixed([]), 0);
  assert.equal(countPrefixed(undefined), 0);
});

test('空树不报错', () => {
  assert.deepEqual(planPrefixUpdates([], 'enable'), []);
  assert.deepEqual(planPrefixUpdates(undefined, 'disable'), []);
});
