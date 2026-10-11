import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../server/db';
import { encrypt } from '../../server/security';
import { AccountVerifier } from '../../server/account-verifier';
import { AiService, defaultAiConfig, resolveChatCompletionsUrl } from '../../server/ai';
import { LotteryEnricher, parseDrawTime } from '../../server/lottery-enricher';

async function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-web-fixes-'));
  const db = await AppDatabase.create(join(directory, 'test.db'));
  return { directory, db };
}

test('AI 根地址会规范化为 Chat Completions 最终端点', () => {
  assert.equal(resolveChatCompletionsUrl('https://tierflow.cn/v1'), 'https://tierflow.cn/v1/chat/completions');
  assert.equal(resolveChatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(resolveChatCompletionsUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.throws(() => resolveChatCompletionsUrl('http://example.com/v1'), /HTTPS/);
});

test('AI 网络错误会展示可定位原因且不会泄露 Key', async () => {
  const item = await databaseFixture(); const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { const error: any = new TypeError('fetch failed'); error.cause = new Error('redirect count exceeded'); throw error; };
    const service = new AiService(item.db);
    await assert.rejects(service.complete({ ...defaultAiConfig, apiKey: 'never-print-this', baseUrl: 'https://tierflow.cn/v1', retries: 0 }, 'test', 'test'), error => {
      assert.match(String(error), /重定向循环/); assert.doesNotMatch(String(error), /never-print-this/); return true;
    });
  } finally { globalThis.fetch = originalFetch; rmSync(item.directory, { recursive: true, force: true }); }
});

test('重复 UID 添加会更新 Cookie 并保留账号 ID 和配置', async () => {
  const item = await databaseFixture();
  try {
    const first = item.db.createAccount({ uid: '123', name: '旧昵称', note: '主号', cookie: 'old' })!;
    item.db.setConfig(first.id, { FollowFeed: [8] });
    const updated = item.db.createAccount({ uid: '123', name: '新昵称', cookie: 'new' })!;
    assert.equal(updated.id, first.id); assert.equal(updated.cookie, 'new'); assert.equal(updated.note, '主号');
    assert.deepEqual(item.db.getConfig(first.id), { FollowFeed: [8] }); assert.equal(item.db.listAccounts().length, 1);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('账号验证只在明确未登录时标记 invalid', async () => {
  const item = await databaseFixture(); const notifications: any = { notifyInvalid: async () => undefined, notifyRecovery: async () => undefined };
  try {
    const account = item.db.createAccount({ uid: '123', name: '账号', cookie: encrypt('DedeUserID=123') })!;
    const transient = new AccountVerifier(item.db, notifications, () => true, () => undefined, async () => ({ ok: false as const, kind: 'network' as const, error: 'ETIMEDOUT' }));
    const transientResult = await transient.verifyOne(account.id);
    assert.equal(transientResult?.transient, true); assert.equal(item.db.getAccount(account.id)?.cookie_status, 'valid');
    const invalid = new AccountVerifier(item.db, notifications, () => true, () => undefined, async () => ({ ok: false as const, kind: 'invalid' as const, error: '账号未登录' }));
    await invalid.verifyOne(account.id);
    assert.equal(item.db.getAccount(account.id)?.cookie_status, 'invalid'); assert.match(item.db.getAccount(account.id)?.verification_error || '', /未登录/);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('结构化抽奖记录会补全字段并保留处理状态', async () => {
  const item = await databaseFixture();
  try {
    const account = item.db.createAccount({ uid: '123', cookie: encrypt('DedeUserID=123') })!;
    item.db.addLottery(account.id, '100000001', 'start');
    const updated = item.db.upsertLottery(account.id, { dyid: '100000001', source: 'follow_feed', author: 'UP主', description: '转发抽奖，10月20日开奖', drawTime: 1792425600, official: false, status: 'candidate', resultReason: '符合抽奖条件' });
    assert.equal(updated.source, 'follow_feed'); assert.equal(updated.author, 'UP主'); assert.equal(updated.enrichment_status, 'complete'); assert.equal(updated.status, 'candidate');
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('历史补全按批次读取详情并解析非官方开奖时间', async () => {
  const item = await databaseFixture(); let acquired = 0; let released = 0;
  try {
    const account = item.db.createAccount({ uid: '123', cookie: encrypt('DedeUserID=123') })!;
    item.db.addLottery(account.id, '100000001', 'start');
    const enricher = new LotteryEnricher(item.db, () => { acquired += 1; return true; }, () => { released += 1; }, async () => ({ ok: true as const, detail: { dyid: '100000001', author: 'UP主', description: '开奖时间10月20日 20:30', official: false, sourceCreatedAt: 1791656548, url: 'https://t.bilibili.com/100000001' } }), async () => null, 0);
    const result = await enricher.runBatch(true); enricher.stop();
    assert.equal(result.processed, 1); assert.equal(acquired, 1); assert.equal(released, 1);
    const row: any = item.db.listLotteries()[0]; assert.equal(row.author, 'UP主'); assert.equal(row.enrichment_status, 'complete'); assert.ok(row.draw_time > 0);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test('文本开奖时间只解析带明确开奖或截止语义的日期', () => {
  assert.ok(parseDrawTime('开奖时间：2026年10月20日 20:30', 1791656548));
  assert.equal(parseDrawTime('活动发布于10月20日，欢迎参加', 1791656548), null);
  assert.equal(parseDrawTime('开奖时间：13月40日', 1791656548), null);
});
