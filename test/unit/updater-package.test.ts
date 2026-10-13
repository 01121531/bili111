import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AppDatabase } from '../../server/db';
import { UpdateService } from '../../server/updater';

test('本地发布包校验后原子保存并成为待部署版本', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-update-package-'));
  try {
    const db = await AppDatabase.create(join(directory, 'lottery.db'));
    const updater = new UpdateService(db, { dataDir: directory });
    const commit = 'a'.repeat(40);
    const content = gzipSync(randomBytes(4096));

    assert.throws(() => updater.uploadPackage(content, 'abc'), /40 位提交号/);
    assert.throws(() => updater.uploadPackage(Buffer.alloc(1024, 7), commit), /gzip/);
    const result = updater.uploadPackage(content, commit);

    assert.equal(result.ok, true);
    assert.equal(result.commit, commit);
    assert.equal(result.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(result.status.remoteCommit, commit);
    assert.equal(result.status.updateSource, 'upload');
    assert.equal(result.status.packageReady, true);
    assert.equal(existsSync(join(directory, 'update-packages', 'pending.tar.gz')), true);
    const metadata = JSON.parse(readFileSync(join(directory, 'update-packages', 'pending.json'), 'utf8'));
    assert.deepEqual({ commit: metadata.commit, sha256: metadata.sha256, size: metadata.size }, { commit, sha256: result.sha256, size: content.length });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('没有本地发布包时不尝试在线检查', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-update-package-'));
  try {
    const db = await AppDatabase.create(join(directory, 'lottery.db'));
    const updater = new UpdateService(db, { dataDir: directory });

    await assert.rejects(() => updater.check(), /请先上传本地发布包/);
    assert.equal(updater.status().updateSource, null);
    assert.equal(updater.status().packageReady, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
