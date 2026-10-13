import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { AppDatabase } from '../../server/db';
import { builtInScheduleDefaults } from '../../server/account-schedules';
import { validateWebConfig } from '../../server/config';

const require = createRequire(import.meta.url);
const { buildCleanupPlan } = require('../../lib/helper/cleanup.js');

test('清理边界按转发发布时间加配置天数计算', () => {
  const now = 20_000_000;
  const plan = buildCleanupPlan([
    { type: 1, dynamic_id: 'expired', origin_uid: '101', create_time: now - 30 * 86400 },
    { type: 1, dynamic_id: 'active', origin_uid: '102', create_time: now - 30 * 86400 + 1 },
    { type: 2, dynamic_id: 'original', origin_uid: '103', create_time: now - 100 * 86400 }
  ], { now, maxDays: 30, dynamicTypes: [1], partitionUids: ['101', '102', '103'] });
  assert.deepEqual(plan.deleteCandidates.map((item: any) => item.dynamicId), ['expired']);
  assert.deepEqual(plan.active.map((item: any) => item.dynamicId), ['active']);
  assert.equal(plan.relevant.length, 2);
});

test('白名单精确匹配且活跃动态保护同一 UP 主', () => {
  const now = 30_000_000;
  const plan = buildCleanupPlan([
    { type: 1, dynamic_id: '123', origin_uid: '900', create_time: now - 40 * 86400 },
    { type: 1, dynamic_id: '1234', origin_uid: '901', create_time: now - 40 * 86400 },
    { type: 1, dynamic_id: 'active', origin_uid: '901', create_time: now - 2 * 86400 }
  ], { now, maxDays: 30, dynamicTypes: [1], whitelist: '123', partitionUids: ['900', '901'] });
  assert.deepEqual(plan.deleteCandidates.map((item: any) => item.dynamicId), ['1234']);
  assert.deepEqual(plan.unfollowCandidates, ['900']);
  assert.ok(plan.protectedUids.includes('901'));
});

test('取关仅限抽奖关注分组且保护信息不完整时全部停止', () => {
  const dynamic = { type: 1, dynamic_id: 'old', origin_uid: '700', create_time: 1 };
  const outside = buildCleanupPlan([dynamic], { now: 40 * 86400, maxDays: 30, partitionUids: ['701'] });
  assert.deepEqual(outside.unfollowCandidates, []);
  const blocked = buildCleanupPlan([dynamic], { now: 40 * 86400, maxDays: 30, partitionUids: ['700'], unresolvedActive: true });
  assert.equal(blocked.unfollowBlocked, true);
  assert.deepEqual(blocked.unfollowCandidates, []);
});

test('清理天数校验范围为 1 到 3650 天', () => {
  assert.equal(validateWebConfig({ clear_max_day: 30 }).clear_max_day, 30);
  assert.throws(() => validateWebConfig({ clear_max_day: 0 }), /不能小于 1/);
  assert.throws(() => validateWebConfig({ clear_max_day: 3651 }), /不能大于 3650/);
  assert.deepEqual(builtInScheduleDefaults.clear, { cron: '0 3 * * *', enabled: false });
});

test('数据库按账号提供活跃 UP 保护并保存清理审计', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-cleanup-'));
  const db = await AppDatabase.create(join(directory, 'test.db'));
  const account = db.createAccount({ uid: '1001', name: '测试账号', cookie: 'encrypted' })!;
  db.upsertLottery(account.id, { dyid: 'd1', authorUid: '9001', sourceCreatedAt: 2_000_000, status: 'participated' });
  db.upsertLottery(account.id, { dyid: 'd2', sourceCreatedAt: 2_000_000, status: 'partial' });
  const protection = db.cleanupProtection(account.id, 1_000_000);
  assert.deepEqual(protection.uids, ['9001']);
  assert.equal(protection.unresolved, true);

  const job = db.createJob(account.id, 'clear_preview');
  const runId = db.createRun(job.id, account.id);
  db.addCleanupRecord(runId, account.id, { action: 'dynamic_delete', targetId: 'd1', status: 'candidate', reason: '发布已满 30 天' });
  db.upsertCleanupSummary(runId, account.id, { preview: true, thresholdDays: 30, scannedCount: 10, expiredCount: 1, deleteCandidateCount: 1 });
  const audit = db.getRunCleanup(runId);
  assert.equal(audit.summary.preview, 1);
  assert.equal(audit.summary.scanned_count, 10);
  assert.equal(audit.records[0].target_id, 'd1');
});
