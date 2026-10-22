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
