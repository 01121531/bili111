import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEngineLogLine } from '../../server/engine';

test('独立 B 站 JSON 错误日志会规范化为中文错误', () => {
  const result = normalizeEngineLogLine('{"code":4101152,"message":"动态不可见","ttl":1}]', 'info');
  assert.equal(result.level, 'error');
  assert.equal(result.message, 'B站返回 4101152（动态不可见）');
  assert.equal(result.normalizedResponse, true);
});

test('带数组包装的 B 站响应不会作为原始 JSON 写入日志', () => {
  const result = normalizeEngineLogLine('[{"code":4101139,"message":"请求数据发生错误","ttl":1}]', 'info');
  assert.equal(result.level, 'error');
  assert.equal(result.message, 'B站返回 4101139（请求数据发生错误）');
});

test('普通动态正文不会被误识别为接口响应', () => {
  const result = normalizeEngineLogLine('正文包含 {示例} 但不包含接口错误', 'info');
  assert.equal(result.level, 'info');
  assert.equal(result.normalizedResponse, false);
  assert.equal(result.message, '正文包含 {示例} 但不包含接口错误');
});
