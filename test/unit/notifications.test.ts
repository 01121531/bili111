import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../server/db';
import { buildWinEmail, EmailNotificationService } from '../../server/notifications';
import initSqlJs from 'sql.js';

async function fixture(sender?: (options: Record<string, unknown>) => Promise<unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-notifications-'));
  const db = await AppDatabase.create(join(directory, 'test.db'));
  const sent: Record<string, unknown>[] = []; const transportOptions: Record<string, unknown>[] = [];
  const service = new EmailNotificationService(db, options => {
    transportOptions.push(options);
    return { sendMail: async mail => { sent.push(mail); return sender ? sender(mail) : { accepted: ['test@qq.com'] }; } };
  });
  service.save({ enabled: true, smtpHost: 'smtp.qq.com', smtpPort: 465, secure: true, username: 'test@qq.com', password: 'secret-auth-code', recipient: 'test@qq.com', notifyWins: true, notifyInvalid: true, notifyRecovery: true, invalidReminderHours: 24 });
  const account = db.createAccount({ cookie: 'encrypted-cookie', uid: '123456', name: '测试账号', note: '主号' })!;
  return { directory, db, service, account, sent, transportOptions };
}

test('SMTP 授权码加密保存且公开配置不回显', async () => {
  const item = await fixture();
  try {
    const stored = item.db.getSetting('email_notification_config')!;
    assert.equal(stored.includes('secret-auth-code'), false);
    assert.equal(item.service.getPublic().passwordConfigured, true);
    assert.equal('password' in item.service.getPublic(), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('旧数据库会增量增加通知和中奖事件字段', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-notifications-migration-')); const filename = join(directory, 'old.db');
  try {
    const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) }); const old = new SQL.Database();
    old.run(`CREATE TABLE win_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, source TEXT NOT NULL, content TEXT NOT NULL, url TEXT, matched INTEGER NOT NULL DEFAULT 1, is_read INTEGER NOT NULL DEFAULT 0, detected_at TEXT NOT NULL);
      CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, channel TEXT NOT NULL, title TEXT, content TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);`);
    writeFileSync(filename, Buffer.from(old.export())); old.close();
    const migrated = await AppDatabase.create(filename); const raw = (migrated as any).db;
    const winColumns = raw.exec('PRAGMA table_info(win_events)')[0].values.map((row: unknown[]) => row[1]); const notificationColumns = raw.exec('PRAGMA table_info(notifications)')[0].values.map((row: unknown[]) => row[1]);
    assert.ok(winColumns.includes('event_key')); assert.ok(winColumns.includes('actor')); assert.ok(notificationColumns.includes('event_type')); assert.ok(notificationColumns.includes('attempts'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('中奖邮件转义动态内容并只保留 B 站 HTTPS 链接', async () => {
  const item = await fixture();
  try {
    const email = buildWinEmail(item.account, [
      { source: 'reply', actor: '<script>坏人</script>', content: '<img src=x onerror=alert(1)>中奖', url: 'https://www.bilibili.com/opus/123', occurredAt: '2026-10-11T01:00:00.000Z' },
      { source: 'message', actor: '用户', content: '点击链接', url: 'https://example.com/steal', occurredAt: '2026-10-11T01:00:00.000Z' }
    ]);
    assert.match(email.html, /&lt;script&gt;坏人/);
    assert.doesNotMatch(email.html, /<script>|<img/);
    assert.match(email.html, /https:\/\/www\.bilibili\.com\/opus\/123/);
    assert.doesNotMatch(email.html, /example\.com/);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('中奖事件按指纹去重并合并为单封邮件', async () => {
  const item = await fixture();
  const runtimeEvent = { type: 'wins_detected' as const, events: [
    { source: 'at', actor: 'UP主', content: '恭喜中奖', url: 'https://t.bilibili.com/123456789', occurredAt: '2026-10-11T01:00:00.000Z' },
    { source: 'reply', actor: '活动方', content: '请填写信息', url: 'https://www.bilibili.com/opus/987654321', occurredAt: '2026-10-11T02:00:00.000Z' }
  ] };
  try {
    await item.service.handleRuntimeEvents(item.account.id, 1, [runtimeEvent]);
    await item.service.handleRuntimeEvents(item.account.id, 2, [runtimeEvent]);
    assert.equal(item.sent.length, 1);
    assert.match(String(item.sent[0].subject), /2 条/);
    assert.equal(item.db.listWins().length, 2);
    assert.equal(item.db.listNotifications().filter((row: any) => row.event_type === 'win_detected').length, 1);
    assert.equal(item.transportOptions[0].host, 'smtp.qq.com');
    assert.equal(item.transportOptions[0].port, 465);
    assert.equal(item.transportOptions[0].secure, true);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('账号失效 24 小时内只提醒一次，恢复也只提醒一次', async () => {
  const item = await fixture();
  try {
    await item.service.handleRuntimeEvents(item.account.id, 1, [{ type: 'account_invalid', reason: 'Cookie 已失效' }]);
    await item.service.handleRuntimeEvents(item.account.id, 2, [{ type: 'account_invalid', reason: 'Cookie 已失效' }]);
    assert.equal(item.sent.length, 1);
    assert.equal(item.db.getAccount(item.account.id)?.cookie_status, 'invalid');
    (item.db as any).db.run('UPDATE notifications SET created_at=? WHERE event_type=?', [new Date(Date.now() - 25 * 3600000).toISOString(), 'account_invalid']);
    await item.service.handleRuntimeEvents(item.account.id, 3, [{ type: 'account_invalid', reason: 'Cookie 已失效' }]);
    assert.equal(item.sent.length, 2);
    await item.service.handleRuntimeEvents(item.account.id, 4, [{ type: 'account_valid' }]);
    await item.service.handleRuntimeEvents(item.account.id, 5, [{ type: 'account_valid' }]);
    assert.equal(item.sent.length, 3);
    assert.equal(item.db.getAccount(item.account.id)?.cookie_status, 'valid');
    assert.match(String(item.sent[2].subject), /已恢复/);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('SMTP 连续失败会记录错误但不会抛出到任务链路', async () => {
  const item = await fixture(async () => { throw new Error('authentication failed secret-auth-code'); });
  try {
    await assert.doesNotReject(item.service.handleRuntimeEvents(item.account.id, 1, [{ type: 'account_invalid', reason: 'Cookie 已失效' }]));
    const record: any = item.db.listNotifications()[0];
    assert.equal(record.status, 'failed');
    assert.equal(record.attempts, 3);
    assert.equal(String(record.error).includes('secret-auth-code'), false);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('账号通知邮箱按账号路由，未配置时继承全局邮箱', async () => {
  const item = await fixture();
  const second = item.db.createAccount({ cookie: 'encrypted-cookie-2', uid: '654321', name: '测试账号2', note: '副号' })!;
  try {
    item.service.saveAccountNotification(item.account.id, { recipient: 'main@example.com; backup@example.com' });
    assert.deepEqual(item.service.getAccountNotification(item.account.id), {
      recipient: 'main@example.com; backup@example.com',
      configuredRecipient: 'main@example.com; backup@example.com',
      inherited: false,
      globalRecipient: 'test@qq.com'
    });
    assert.equal(item.service.getAccountNotification(second.id).recipient, 'test@qq.com');
    await item.service.notifyWins(item.account, [{ source: 'reply', actor: '活动方', content: '主号中奖', url: 'https://www.bilibili.com/opus/1' }], 1);
    await item.service.notifyWins(second, [{ source: 'reply', actor: '活动方', content: '副号中奖', url: 'https://www.bilibili.com/opus/2' }], 2);
    assert.equal(item.sent[0].to, 'main@example.com; backup@example.com');
    assert.equal(item.sent[1].to, 'test@qq.com');
    await item.service.saveAccountNotification(item.account.id, { recipient: '' });
    assert.equal(item.service.getAccountNotification(item.account.id).inherited, true);
    assert.equal(item.service.getAccountNotification(item.account.id).recipient, 'test@qq.com');
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('账号测试邮件使用账号最终收件邮箱且不回显授权码', async () => {
  const item = await fixture();
  try {
    item.service.saveAccountNotification(item.account.id, { recipient: 'account@example.com' });
    const result = await item.service.sendTest(item.account.id);
    assert.equal(result?.ok, true);
    assert.equal(item.sent[0].to, 'account@example.com');
    assert.doesNotMatch(JSON.stringify(item.sent[0]), /secret-auth-code/);
    assert.equal(item.db.listNotifications()[0].account_id, item.account.id);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('补充评论失败按账号汇总发送且标记重试次数', async () => {
  const item = await fixture();
  try {
    item.service.saveAccountNotification(item.account.id, { recipient: 'account@example.com' });
    const result = await item.service.notifyCommentBackfillFailures(item.account, [
      { dyid: '10001', author: '活动方', url: 'https://www.bilibili.com/opus/10001', reason: '评论区关闭', attemptCount: 2 },
      { dyid: '10002', reason: '动态不存在', attemptCount: 3 }
    ], 9);
    assert.equal(result?.ok, true);
    assert.equal(item.sent.length, 1);
    assert.equal(item.sent[0].to, 'account@example.com');
    assert.match(String(item.sent[0].subject), /补充评论失败（2 条）/);
    assert.match(String(item.sent[0].text), /尝试：2\/3/);
    assert.match(String(item.sent[0].text), /已达到重试上限/);
    const record: any = item.db.listNotifications()[0];
    assert.equal(record.event_type, 'comment_backfill_failed');
    assert.equal(record.run_id, 9);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});
