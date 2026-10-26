import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunStatus, runStatusMessage } from '../../server/scheduler';

test('运行状态根据目标结果识别成功、部分完成和失败', () => {
  assert.equal(resolveRunStatus(0, { partial: 0, failed: 0 }), 'success');
  assert.equal(resolveRunStatus(0, { partial: 2, failed: 0 }), 'partial');
  assert.equal(resolveRunStatus(0, { partial: 2, failed: 1 }), 'failed');
  assert.equal(resolveRunStatus(1, { partial: 0, failed: 0 }), 'failed');
});

test('部分完成与失败状态包含可读统计', () => {
  assert.equal(runStatusMessage('success', { partial: 0, failed: 0 }), undefined);
  assert.match(runStatusMessage('partial', { partial: 3, failed: 0 }) || '', /3 个目标/);
  assert.match(runStatusMessage('failed', { partial: 2, failed: 4 }) || '', /4 个目标失败/);
  assert.match(runStatusMessage('failed', { partial: 2, failed: 4 }) || '', /2 个目标部分完成/);
});
