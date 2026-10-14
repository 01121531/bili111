import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../server/db';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-attempts-'));
  const filename = join(directory, 'test.db');
  const db = await AppDatabase.create(filename);
  const account = db.createAccount({ cookie: 'encrypted-cookie', uid: '123', name: '测试账号' })!;
  const job = db.createJob(account.id, 'start'); const runId = db.createRun(job.id, account.id);
  db.upsertLottery(account.id, { dyid: '90001', author: '测试UP', description: '抽奖正文', status: 'candidate', runId });
  return { directory, filename, db, account, runId };
}

test('参与动作尝试持久化、汇总、搜索并保持幂等', async () => {
  const item = await fixture();
  try {
    const input = {
      dyid: '90001', overallStatus: 'partial', resultReason: '评论失败；转发失败',
      comment: { status: 'failed', code: 13, reason: '评论失败：B站返回 -107（账号未转正）', attempts: [{ action: 'comment', status: 'failed', internalCode: 13, providerCode: -107, providerMessage: '账号未转正', errorType: 'bili_api', httpStatus: 200, attemptNo: 1, targetId: 'rid-1' }] },
      relay: { status: 'failed', code: 1, reason: '转发失败：网络错误 ECONNRESET', attempts: [{ action: 'relay', status: 'failed', internalCode: 1, errorType: 'network', transportCode: 'ECONNRESET', retryable: true, attemptNo: 1, targetId: '90001' }] },
      like: { status: 'success', code: 0, reason: '点赞成功', attempts: [{ action: 'like', status: 'success', internalCode: 0, providerCode: 0, attemptNo: 1, targetId: '90001' }] }
    };
    const record = item.db.upsertParticipation(item.account.id, item.runId, input);
    item.db.upsertParticipation(item.account.id, item.runId, input);
    const attempts = item.db.getParticipationAttempts(record.id);
    assert.equal(attempts.length, 3);
    assert.equal(attempts.find((attempt: any) => attempt.action === 'comment').provider_code, -107);
    assert.equal(attempts.find((attempt: any) => attempt.action === 'relay').transport_code, 'ECONNRESET');

    const listed = item.db.listRunParticipations(item.runId, { search: '-107' });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].comment_attempt_count, 1);
    assert.equal(listed.items[0].comment_last_provider_message, '账号未转正');
    assert.equal(listed.items[0].relay_last_transport_code, 'ECONNRESET');
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('历史日志只有唯一匹配时恢复真实错误，歧义记录保持原状', async () => {
  const item = await fixture();
  try {
    const record = item.db.upsertParticipation(item.account.id, item.runId, {
      dyid: '90001', overallStatus: 'failed', resultReason: '评论失败：未知错误',
      comment: { status: 'failed', code: 1, reason: '评论失败：未知错误' }
    });
    item.db.addLog(item.runId, item.account.id, 'info', '自动评论', '[Error] 未知错误');
    item.db.addLog(item.runId, item.account.id, 'info', 'engine', JSON.stringify({ code: -107, message: '账号未转正' }));
    item.db.addLog(item.runId, item.account.id, 'warn', '抽奖信息', 'dyid: 90001, rid: 1');
    (item.db as any).run("DELETE FROM system_settings WHERE key='participation_error_backfill_v1'");

    const migrated = await AppDatabase.create(item.filename);
    const attempts = migrated.getParticipationAttempts(record.id);
    const participation = migrated.listRunParticipations(item.runId).items[0];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].provider_code, -107);
    assert.match(participation.comment_reason, /-107.*账号未转正/);
    assert.match(participation.result_reason, /-107.*账号未转正/);

    (migrated as any).run("DELETE FROM system_settings WHERE key='participation_error_backfill_v1'");
    const rerun = await AppDatabase.create(item.filename);
    assert.equal(rerun.getParticipationAttempts(record.id).length, 1);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});
