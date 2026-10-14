import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../server/db';
import { AccountScheduleService, builtInScheduleDefaults, nextScheduleRun, validateScheduleDefaults } from '../../server/account-schedules';
import { diffFromBase, mergedConfig, publicConfigPayload, runtimeConfig } from '../../server/config';

async function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-defaults-'));
  const db = await AppDatabase.create(join(directory, 'test.db'));
  return { directory, db };
}

function schedulerStub() {
  return { enqueue: () => null } as any;
}

test('默认账号配置按内置、默认和账号覆盖顺序合并', () => {
  const inherited = { uid_scan_page: 8, maxday: 30, APIs: ['https://example.com/list'] };
  const account = { uid_scan_page: 12, maxday: null };
  const effective = mergedConfig(account, inherited);
  assert.equal(effective.uid_scan_page, 12);
  assert.equal(effective.maxday, Infinity);
  assert.deepEqual(effective.APIs, ['https://example.com/list']);

  const payload = publicConfigPayload(account, inherited, 'account');
  assert.equal(payload.inherited, false);
  assert.equal(payload.defaults.uid_scan_page, 8);
  assert.equal(payload.effective.uid_scan_page, 12);

  const changed = { ...payload.effective, uid_scan_page: 8, maxday: null };
  const diff = diffFromBase(changed, inherited).diff;
  assert.deepEqual(diff, { maxday: null });

  const runtime = runtimeConfig(7, account, undefined, inherited) as any;
  assert.equal(runtime.default_config.uid_scan_page, 8);
  assert.equal(runtime.config_7.uid_scan_page, 12);
  assert.equal(runtime.config_7.maxday, Infinity);
  assert.equal(runtime.default_config.chatmodel, '11');
  assert.equal(mergedConfig({ chatmodel: '01' }).chatmodel, '11');
});

test('恢复默认和应用到全部账号只清除业务覆盖并保留 AI', async () => {
  const item = await databaseFixture();
  try {
    const first = item.db.createAccount({ uid: '1001', cookie: 'cookie-1' })!;
    const second = item.db.createAccount({ uid: '1002', cookie: 'cookie-2' })!;
    item.db.setConfig(first.id, { uid_scan_page: 9, ai: { enableJudge: true, commentPrompt: '账号一' }, notifications: { recipient: 'main@example.com' } });
    item.db.setConfig(second.id, { FollowFeed: [9], ai: { enableRelay: true } });

    assert.deepEqual(item.db.resetConfig(first.id), { ai: { enableJudge: true, commentPrompt: '账号一' }, notifications: { recipient: 'main@example.com' } });
    const count = item.db.resetAllConfigs();
    assert.equal(count, 2);
    assert.deepEqual(item.db.getConfig(first.id), { ai: { enableJudge: true, commentPrompt: '账号一' }, notifications: { recipient: 'main@example.com' } });
    assert.deepEqual(item.db.getConfig(second.id), { ai: { enableRelay: true } });
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('新账号继承默认计划，默认变化不覆盖独立计划', async () => {
  const item = await databaseFixture();
  let service: AccountScheduleService | undefined;
  try {
    const independent = item.db.createAccount({ uid: '2001', cookie: 'cookie-1' })!;
    const inherited = item.db.createAccount({ uid: '2002', cookie: 'cookie-2' })!;
    item.db.upsertSchedule(independent.id, 'start', '0 7 * * *', true, nextScheduleRun('0 7 * * *'));
    service = new AccountScheduleService(item.db, schedulerStub());

    const independentRows = service.listAccount(independent.id);
    const inheritedRows = service.listAccount(inherited.id);
    assert.equal(independentRows.length, 8);
    assert.equal(inheritedRows.length, 8);
    assert.equal(independentRows.find(row => row.type === 'start')?.is_override, 1);
    assert.equal(inheritedRows.every(row => row.is_override === 0), true);
    const commentSchedule = inheritedRows.find(row => row.type === 'comment_backfill');
    assert.equal(commentSchedule?.cron, '0 4 * * *');
    assert.equal(commentSchedule?.enabled, 1);
    const dailySchedule = inheritedRows.find(row => row.type === 'daily');
    assert.equal(dailySchedule?.cron, '0 5 * * *');
    assert.equal(dailySchedule?.enabled, 1);
    const liveAutomationSchedule = inheritedRows.find(row => row.type === 'live_automation');
    assert.equal(liveAutomationSchedule?.cron, '0 20 * * *');
    assert.equal(liveAutomationSchedule?.enabled, 1);
    const streamingSchedule = inheritedRows.find(row => row.type === 'streaming');
    assert.equal(streamingSchedule?.cron, '0 21 * * *');
    assert.equal(streamingSchedule?.enabled, 0);

    service.saveDefaults({ start: { cron: '0 10 * * *', enabled: true } });
    assert.equal(service.listAccount(independent.id).find(row => row.type === 'start')?.cron, '0 7 * * *');
    assert.equal(service.listAccount(inherited.id).find(row => row.type === 'start')?.cron, '0 10 * * *');
    assert.equal(service.listAccount(inherited.id).find(row => row.type === 'start')?.enabled, 1);

    assert.equal(service.applyDefaultsToAll(), 2);
    const applied = service.listAccount(independent.id).find(row => row.type === 'start');
    assert.equal(applied?.cron, '0 10 * * *');
    assert.equal(applied?.is_override, 0);
  } finally { service?.stop(); rmSync(item.directory, { recursive: true, force: true }); }
});

test('服务重启保留未变化继承任务的下次执行时间', async () => {
  const item = await databaseFixture();
  let firstService: AccountScheduleService | undefined;
  let secondService: AccountScheduleService | undefined;
  try {
    const account = item.db.createAccount({ uid: '2101', cookie: 'cookie' })!;
    firstService = new AccountScheduleService(item.db, schedulerStub());
    firstService.saveDefaults({ start: { cron: '0 10 * * *', enabled: true } });
    const before = firstService.listAccount(account.id).find(row => row.type === 'start')?.next_run_at;
    firstService.stop(); firstService = undefined;

    secondService = new AccountScheduleService(item.db, schedulerStub());
    const after = secondService.listAccount(account.id).find(row => row.type === 'start')?.next_run_at;
    assert.equal(after, before);
  } finally { firstService?.stop(); secondService?.stop(); rmSync(item.directory, { recursive: true, force: true }); }
});

test('重复添加 UID 不重置账号配置或独立定时任务', async () => {
  const item = await databaseFixture();
  let service: AccountScheduleService | undefined;
  try {
    const first = item.db.createAccount({ uid: '3001', cookie: 'old-cookie' })!;
    item.db.setConfig(first.id, { uid_scan_page: 11, ai: { enableComments: false } });
    service = new AccountScheduleService(item.db, schedulerStub());
    service.save(first.id, 'check', '0 * * * *', true);

    const updated = item.db.createAccount({ uid: '3001', cookie: 'new-cookie', name: '更新昵称' })!;
    service.ensureAccount(updated.id);
    assert.equal(updated.id, first.id);
    assert.deepEqual(item.db.getConfig(first.id), { uid_scan_page: 11, ai: { enableComments: false } });
    const schedule = service.listAccount(first.id).find(row => row.type === 'check');
    assert.equal(schedule?.cron, '0 * * * *');
    assert.equal(schedule?.is_override, 1);
  } finally { service?.stop(); rmSync(item.directory, { recursive: true, force: true }); }
});

test('默认计划校验拒绝无效 Cron，并按北京时间计算下次运行', () => {
  assert.throws(() => validateScheduleDefaults({ start: { cron: 'bad cron', enabled: true } }), /Cron/);
  const defaults = validateScheduleDefaults({}, builtInScheduleDefaults);
  assert.deepEqual(defaults, builtInScheduleDefaults);
  assert.equal(nextScheduleRun('0 9 * * *', new Date('2026-01-01T00:30:00.000Z')), '2026-01-01T01:00:00.000Z');
});

test('强制评论迁移清除旧覆盖并保留 AI 与通知配置', async () => {
  const item = await databaseFixture();
  try {
    const account = item.db.createAccount({ uid: '9001', cookie: 'cookie' })!;
    item.db.setSetting('global_config', JSON.stringify({ chatmodel: '01', uid_scan_page: 8 }));
    item.db.setConfig(account.id, { chatmodel: '00', ai: { enableComments: true }, notifications: { recipient: 'test@example.com' } });
    assert.equal(item.db.normalizeForcedCommentConfig(), 2);
    assert.deepEqual(JSON.parse(item.db.getSetting('global_config') || '{}'), { uid_scan_page: 8 });
    assert.deepEqual(item.db.getConfig(account.id), { ai: { enableComments: true }, notifications: { recipient: 'test@example.com' } });
    assert.equal(mergedConfig(item.db.getConfig(account.id), JSON.parse(item.db.getSetting('global_config') || '{}')).chatmodel, '11');
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});
