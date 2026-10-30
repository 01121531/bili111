import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../server/db';

test('高频日志写入会合并落盘，显式 flush 后可完整恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-db-flush-'));
  const filename = join(directory, 'test.db');
  const db = await AppDatabase.create(filename, { flushIntervalMs: 60000 });
  const reopened = await (async () => {
    try {
      const sizeAfterCreate = statSync(filename).size;
      const account = db.createAccount({ uid: '991', name: '持久化测试', cookie: 'encrypted-cookie' })!;
      const job = db.createJob(account.id, 'start');
      const runId = db.createRun(job.id, account.id);
      for (let index = 0; index < 500; index += 1) {
        db.addLog(runId, account.id, 'info', '测试', `高频日志 ${index}`);
      }

      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(statSync(filename).size, sizeAfterCreate, '防抖窗口内不应反复导出整库');

      await Promise.all([db.flushNow(), db.flushNow()]);
      const restored = await AppDatabase.create(filename, { flushIntervalMs: 60000 });
      assert.equal(restored.listLogs(runId, 1000).length, 500);
      return restored;
    } finally {
      await db.close();
    }
  })();

  try {
    assert.equal(reopened.getSetting('admin_password_hash')?.includes('.'), true);
  } finally {
    await reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('历史运行状态按 partial 和 failed 统计修正且迁移可重复执行', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-db-run-status-'));
  const filename = join(directory, 'test.db');
  let reopened: AppDatabase | undefined;
  try {
    const initial = await AppDatabase.create(filename, { flushIntervalMs: 60000 });
    const account = initial.createAccount({ uid: '992', name: '状态迁移测试', cookie: 'encrypted-cookie' })!;
    const partialJob = initial.createJob(account.id, 'start');
    const partialRun = initial.createRun(partialJob.id, account.id);
    initial.finishRun(partialRun, 'success', { partial_count: 2 });
    initial.updateJob(partialJob.id, 'success');
    const failedJob = initial.createJob(account.id, 'start');
    const failedRun = initial.createRun(failedJob.id, account.id);
    initial.finishRun(failedRun, 'success', { failed_count: 1, error: '退出码 0' });
    initial.updateJob(failedJob.id, 'success');
    (initial as any).db.run("DELETE FROM system_settings WHERE key='run_status_consistency_v1'");
    await initial.flushNow();
    await initial.close();

    reopened = await AppDatabase.create(filename, { flushIntervalMs: 60000 });
    assert.equal(reopened.getRun(partialRun)?.status, 'partial');
    assert.equal(reopened.getRun(failedRun)?.status, 'failed');
    assert.equal(reopened.getJob(partialJob.id)?.status, 'partial');
    assert.equal(reopened.getJob(failedJob.id)?.status, 'failed');
    assert.equal(reopened.getSetting('run_status_consistency_v1')?.length! > 0, true);
    await reopened.close();

    reopened = await AppDatabase.create(filename, { flushIntervalMs: 60000 });
    assert.equal(reopened.getRun(partialRun)?.status, 'partial');
    assert.equal(reopened.getRun(failedRun)?.status, 'failed');
  } finally {
    await reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('视频转发明细按运行和 AID 幂等保存文案来源与真实错误', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-db-video-share-'));
  const filename = join(directory, 'test.db');
  let db: AppDatabase | undefined;
  try {
    db = await AppDatabase.create(filename, { flushIntervalMs: 60000 });
    const account = db.createAccount({ uid: '993', name: '视频转发测试', cookie: 'encrypted-cookie' })!;
    const job = db.createJob(account.id, 'start');
    const runId = db.createRun(job.id, account.id);

    db.upsertVideoShare(runId, account.id, {
      uid: '123', aid: '456', content: 'AI 视频附言', source: 'ai',
      status: 'failed', reason: 'B站返回 4126021（等级不足）',
      providerCode: 4126021, providerMessage: '等级不足', errorType: 'bili_api',
      httpStatus: 200, occurredAt: '2026-10-30T00:00:00.000Z'
    });
    db.upsertVideoShare(runId, account.id, {
      uid: '123', aid: '456', content: '最终备用附言', source: 'fallback',
      status: 'success', reason: '分享成功', occurredAt: '2026-10-30T00:01:00.000Z'
    });

    const data = db.listRunVideoShares(runId);
    assert.equal(data.items.length, 1);
    assert.equal(data.summary.success, 1);
    assert.equal(data.items[0].content, '最终备用附言');
    assert.equal(data.items[0].source, 'fallback');
    assert.equal(data.items[0].status, 'success');
  } finally {
    await db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
