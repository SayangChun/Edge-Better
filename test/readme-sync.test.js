import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/** 统计 test 目录中 node:test 的用例总数（行首 test( 调用） */
function countUnitTests() {
  const dir = path.join(ROOT, 'test');
  let total = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.test.js')) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    total += (src.match(/^\s*test\(/gm) || []).length;
  }
  return total;
}

test('README 功能章节的版本标注与 manifest.version 一致', () => {
  const m = readme.match(/^## 功能（v(.+)）$/m);
  assert.ok(m, 'README 缺少「## 功能（vX.Y.Z）」标题');
  assert.equal(
    m[1],
    manifest.version,
    `README 标注 v${m[1]} 与 manifest.json 的 ${manifest.version} 不一致——发版时请同步更新 README`
  );
});

test('README 声称的单元测试项数与实际一致', () => {
  const m = readme.match(/单元测试（node:test，(\d+) 项/);
  assert.ok(m, 'README 缺少「单元测试（node:test，N 项）」标注');
  const actual = countUnitTests();
  assert.equal(
    Number(m[1]),
    actual,
    `README 声称 ${m[1]} 项，实际 ${actual} 项——请同步更新 README`
  );
});
