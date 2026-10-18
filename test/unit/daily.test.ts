import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../server/db';
import { DailyTaskRunner, defaultDailyConfig, mergeDailyConfig } from '../../server/daily';
import { DailyBiliClient } from '../../server/daily-bili';
import { LongTaskManager, safeMediaName } from '../../server/live-tasks';
import { encrypt } from '../../server/security';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('每日任务配置按默认、账号覆盖合并并限制投币上限', () => {
  const inherited = { enabled: true, experience: { watch: true, coinLimit: 4 }, charge: { targetUid: '123' } };
  const effective = mergeDailyConfig({ experience: { share: true, coinLimit: 99 }, charge: { enabled: true } }, inherited);
  assert.equal(effective.enabled, true);
  assert.equal(effective.experience.watch, true);
  assert.equal(effective.experience.share, true);
  assert.equal(effective.experience.coinLimit, 5);
  assert.equal(effective.charge.targetUid, '123');
});

test('BiliOutils 扩展动作默认关闭并限制资源与长任务上限', () => {
  assert.equal(defaultDailyConfig.signIns.live, false);
  assert.equal(defaultDailyConfig.resourceTasks.bigPointExchange, false);
  assert.equal(defaultDailyConfig.community.matchGuess, false);
  assert.equal(defaultDailyConfig.liveAutomation.enabled, false);
  assert.equal(defaultDailyConfig.streaming.enabled, false);

  const effective = mergeDailyConfig({
    resourceTasks: { giftExpireHours: 9999, giftMaxCount: 999, dailyBatteryMaxActions: 999 },
    community: { matchCoins: 999, matchMax: 999, blacklistMax: 999 },
    liveAutomation: { durationMinutes: 999, maxRedPackets: 999, maxDanmaku: 999 },
    streaming: { maxDurationMinutes: 999 }
  });
  assert.equal(effective.resourceTasks.giftExpireHours, 720);
  assert.equal(effective.resourceTasks.giftMaxCount, 100);
  assert.equal(effective.resourceTasks.dailyBatteryMaxActions, 20);
  assert.equal(effective.community.matchCoins, 10);
  assert.equal(effective.community.matchMax, 20);
  assert.equal(effective.community.blacklistMax, 100);
  assert.equal(effective.liveAutomation.durationMinutes, 360);
  assert.equal(effective.liveAutomation.maxRedPackets, 50);
  assert.equal(effective.liveAutomation.maxDanmaku, 20);
  assert.equal(effective.streaming.maxDurationMinutes, 360);
  assert.match(safeMediaName('video.MP4'), /\.mp4$/);
  assert.throws(() => safeMediaName('payload.exe'), /不支持的媒体格式/);
});

test('每日动作尝试和首次风险确认按账号持久化', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-daily-audit-'));
  try {
    const db = await AppDatabase.create(join(directory, 'test.db'));
    const account = db.createAccount({ uid: '9010', cookie: 'cookie' })!;
    db.saveDailyRiskConsent('account', account.id, 'match_guess');
    db.saveDailyRiskConsent('account', account.id, 'match_guess');
    assert.equal(db.hasDailyRiskConsent('account', account.id, 'match_guess'), true);
    assert.equal(db.listDailyRiskConsents('account', account.id).length, 1);

    db.addDailyActionAttempt(account.id, 31, '2026-10-14', 'match_guess', 'case-1', 1, {
      status: 'failed', providerCode: -412, providerMessage: '请求被拦截', errorType: 'bili_api', httpStatus: 200, retryable: false, reason: 'B站返回 -412（请求被拦截）'
    });
    db.addDailyActionAttempt(account.id, 31, '2026-10-14', 'match_guess', 'case-1', 1, {
      status: 'failed', providerCode: -412, providerMessage: '重复事件', errorType: 'bili_api', httpStatus: 200, retryable: false, reason: '重复事件'
    });
    const attempts = db.listDailyActionAttempts(31) as any[];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].provider_code, -412);
    assert.equal(attempts[0].provider_message, '请求被拦截');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('等待同账号普通任务的长任务可在启动前取消并结束作业', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-long-cancel-'));
  try {
    const db = await AppDatabase.create(join(directory, 'test.db'));
    const account = db.createAccount({ uid: '9011', cookie: encrypt('DedeUserID=9011; bili_jct=test') })!;
    const manager = new LongTaskManager(db, () => undefined, () => true, () => undefined);
    const queued = manager.enqueue(account.id, 'live_automation');
    assert.equal(manager.cancel(Number(queued.session.id)), true);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(db.getLongTaskSession(Number(queued.session.id))?.status, 'cancelled');
    assert.equal(db.getJob(Number(queued.job.id))?.status, 'cancelled');
    await manager.shutdown();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('每日任务预览只读取本地状态，不生成写操作记录', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-daily-'));
  try {
    const db = await AppDatabase.create(join(directory, 'test.db'));
    const account = db.createAccount({ uid: '9001', cookie: 'DedeUserID=9001; bili_jct=test' })!;
    const runner = new DailyTaskRunner(db);
    const preview = runner.preview(account, defaultDailyConfig);
    assert.equal(preview.taskDate.length, 10);
    assert.equal(preview.actions.some(item => item.action === 'coin_video' && item.enabled === false), true);
    assert.equal(db.listDailyActionsForDate(account.id, preview.taskDate).length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('每日动作记录按账号、日期、动作幂等更新', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-daily-record-'));
  try {
    const db = await AppDatabase.create(join(directory, 'test.db'));
    const account = db.createAccount({ uid: '9002', cookie: 'cookie' })!;
    const first = db.upsertDailyAction(account.id, 1, '2026-10-14', { action: 'coin_video', status: 'failed', reason: '第一次失败', attemptCount: 1 });
    const second = db.upsertDailyAction(account.id, 2, '2026-10-14', { action: 'coin_video', status: 'success', reason: '已完成', attemptCount: 2 });
    assert.equal(first.id, second.id);
    assert.equal(second.status, 'success');
    assert.equal(db.listDailyActionsForDate(account.id, '2026-10-14').length, 1);
    db.upsertDailyAction(account.id, 3, '2026-10-13', { action: 'share_video', status: 'success', reason: '昨日完成' });
    assert.deepEqual(db.dailyStats(account.id, '2026-10-14'), { total: 1, success: 1, completed: 0, skipped: 0, failed: 0, throttled: 0 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('默认关闭的动作只验证账号，不发送 B 站写请求', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-daily-empty-run-'));
  const originalFetch = globalThis.fetch; const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: String(init?.method || 'GET') });
    return jsonResponse({ code: 0, data: { isLogin: true, mid: 9003, level_info: { current_level: 6 } } });
  }) as typeof fetch;
  try {
    const db = await AppDatabase.create(join(directory, 'test.db'));
    const account = db.createAccount({ uid: '9003', cookie: encrypt('DedeUserID=9003; bili_jct=test') })!;
    const result = await new DailyTaskRunner(db).run(account, 1, defaultDailyConfig);
    assert.equal(result.code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls.some(call => call.method === 'POST'), false);
    assert.equal(db.listDailyActions(1).some((item: any) => item.action === 'watch_video' && item.status === 'skipped'), true);
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('限定动作执行不会触发同组其他写操作', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-daily-selected-'));
  const originalFetch = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 9012, level_info: { current_level: 6 } } });
    if (url.includes('/x/member/web/exp/reward')) return jsonResponse({ code: 0, data: { watch: false, share: false } });
    if (url.includes('/x/web-interface/ranking/v2')) return jsonResponse({ code: 0, data: { list: [{ aid: 1, bvid: 'BV1selected', cid: 2, duration: 10, title: '限定动作目标' }] } });
    if (url.includes('/x/click-interface/web/heartbeat')) return jsonResponse({ code: 0, data: {} });
    return jsonResponse({ code: -404, message: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    const db = await AppDatabase.create(join(directory, 'test.db'));
    const account = db.createAccount({ uid: '9012', cookie: encrypt('DedeUserID=9012; bili_jct=test') })!;
    const config = mergeDailyConfig({ experience: { watch: true, share: true }, requestDelay: 0, retryTimes: 0 });
    const result = await new DailyTaskRunner(db).run(account, 41, config, { actions: ['watch_video'] });
    const taskDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    assert.equal(result.code, 0);
    assert.equal(calls.some(url => url.includes('/heartbeat')), true);
    assert.equal(calls.some(url => url.includes('/share/add')), false);
    assert.equal(db.getDailyAction(account.id, taskDate, 'share_video')?.status, 'skipped');
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('观看视频使用排行榜目标并提交脱敏所需的心跳字段', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 42, level_info: { current_level: 5 } } });
    if (url.includes('/x/member/web/exp/reward')) return jsonResponse({ code: 0, data: { watch: false, share: false } });
    if (url.includes('/x/web-interface/ranking/v2')) return jsonResponse({ code: 0, data: { list: [{ aid: 123, bvid: 'BV1test', cid: 456, duration: 20, title: '测试视频' }] } });
    if (url.includes('/x/click-interface/web/heartbeat')) return jsonResponse({ code: 0, message: '0' });
    return jsonResponse({ code: -404, message: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    const config = mergeDailyConfig({ experience: { watch: true }, retryTimes: 0 });
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', config);
    assert.equal((await client.validate()).ok, true);
    const outcome = await client.watchVideo();
    assert.equal(outcome.result.status, 'success');
    assert.equal(outcome.targetId, 'BV1test');
    const heartbeat = calls.find(call => call.url.includes('/heartbeat'))!;
    assert.equal(heartbeat.init?.method, 'POST');
    const body = new URLSearchParams(String(heartbeat.init?.body));
    assert.equal(body.get('aid'), '123');
    assert.equal(body.get('cid'), '456');
    assert.equal(body.get('csrf'), 'csrf-value');
  } finally { globalThis.fetch = originalFetch; }
});

test('分享视频使用移动端完成接口并将账号级 -403 记录为当日跳过', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 42 } });
    if (url.includes('/x/member/web/exp/reward')) return jsonResponse({ code: 0, data: { share: false } });
    if (url.includes('/x/web-interface/ranking/v2')) return jsonResponse({ code: 0, data: { list: [{ aid: 123, bvid: 'BV1share', cid: 456, duration: 20, title: '分享目标' }] } });
    if (url.includes('/x/share/finish')) return jsonResponse({ code: -403, message: '账号异常,操作失败' });
    return jsonResponse({ code: -404, message: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', mergeDailyConfig({ experience: { share: true }, retryTimes: 0 }));
    await client.validate();
    const outcome = await client.shareVideo();
    assert.equal(outcome.result.status, 'skipped');
    assert.equal(outcome.result.providerCode, -403);
    assert.match(outcome.result.reason, /账号级分享风控/);
    const share = calls.find(call => call.url.includes('/x/share/finish'))!;
    assert.equal(calls.some(call => call.url.includes('/x/web-interface/share/add')), false);
    const body = new URLSearchParams(String(share.init?.body));
    assert.equal(body.get('oid'), '123');
    assert.equal(body.get('platform'), 'android');
    assert.equal(body.get('share_origin'), 'vinfo_share');
    assert.equal(body.get('csrf'), 'csrf-value');
  } finally { globalThis.fetch = originalFetch; }
});

test('每日任务将已下线、非会员和余额不足动作记录为跳过，并修正漫画分享平台参数', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.includes('/xlive/web-ucenter/v1/sign/WebGetSignInfo')) return jsonResponse({ code: 0, data: { is_signed: 0 } });
    if (url.includes('/xlive/web-ucenter/v1/sign/DoSign')) return jsonResponse({ code: 1, message: '签到活动已下线，无法使用。' });
    if (url.includes('/x/vip/experience/add')) return jsonResponse({ code: 235007, message: '当前非有效大会员!' });
    if (url.includes('/xlive/revenue/v1/wallet/getStatus')) return jsonResponse({ code: 0, data: { silver_2_coin_left: 1 } });
    if (url.includes('/xlive/revenue/v1/wallet/silver2coin')) return jsonResponse({ code: 403, message: '银瓜子余额不足' });
    if (url.includes('/twirp/activity.v1.Activity/ShareComic')) return jsonResponse({ code: 0, data: {} });
    return jsonResponse({ code: 0, data: { isLogin: true, mid: 42, level_info: { current_level: 6 } } });
  }) as typeof fetch;
  try {
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', mergeDailyConfig({ requestDelay: 0, retryTimes: 0, experience: { devicePlatform: 'android' } }));
    await client.validate();
    assert.equal((await client.liveSign()).result.status, 'skipped');
    assert.equal((await client.vipExperience()).result.status, 'skipped');
    assert.equal((await client.silverToCoin()).result.status, 'skipped');
    assert.equal((await client.mangaShare()).result.status, 'success');
    assert.equal(calls.some(url => url.includes('ShareComic?platform=android')), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('直播天选从首页和关注直播间发现候选，不再调用高风控分区列表', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 42 } });
    if (url.includes('/index/getList')) return jsonResponse({ code: 0, data: { room_list: [{ list: [{ roomid: 1001, pendant_Info: { 2: { pendent_id: 504 } } }] }] } });
    if (url.includes('/user/following')) return jsonResponse({ code: 0, data: { list: [{ roomid: 1002, live_status: 1 }] } });
    if (url.includes('/Anchor/Check')) return jsonResponse({ code: 0, data: { id: 9, status: 1, award_name: '测试奖品', send_gift_ensure: 0, require_type: 0, gift_id: 0, gift_num: 0, gift_price: 0 } });
    if (url.includes('/Anchor/Join')) return jsonResponse({ code: 0, data: {} });
    return jsonResponse({ code: -404, message: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', mergeDailyConfig({ liveLottery: { enabled: true, maxPerDay: 2 }, requestDelay: 0, retryTimes: 0 }));
    await client.validate();
    const outcome = await client.liveLottery();
    assert.equal(outcome.result.status, 'success');
    assert.deepEqual(outcome.details?.map(item => item.targetId), ['1001', '1002']);
    assert.equal(calls.some(call => call.url.includes('/second/getList')), false);
    assert.equal(calls.filter(call => call.url.includes('/Anchor/Join')).length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('长运行直播任务在未配置房间时自动发现正在直播的关注 UP 主', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.includes('/xlive/web-ucenter/user/following')) return jsonResponse({ code: 0, data: { list: [{ roomid: 2001, live_status: 1 }, { roomid: 2002, live_status: 0 }], totalPage: 1 } });
    if (url.includes('/room/v1/Room/get_info')) return jsonResponse({ code: 0, data: { uid: 9001, parent_area_id: 1, area_id: 2 } });
    if (url.includes('/xlive/data-interface/v1/heartbeat')) return jsonResponse({ code: 0, data: {} });
    return jsonResponse({ code: 0, data: { isLogin: true, mid: 42 } });
  }) as typeof fetch;
  try {
    const config = structuredClone(defaultDailyConfig);
    config.liveAutomation = { ...config.liveAutomation, enabled: true, rooms: [], heartbeat: true, durationMinutes: -1 };
    config.requestDelay = 0; config.retryTimes = 0;
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', config);
    const events: Array<{ action: string; target: string; reason: string }> = [];
    const rooms = await (client as any).discoverLiveRooms((action: string, target: string, item: any) => { events.push({ action, target, reason: item.reason }); });
    assert.deepEqual(rooms, ['2001']);
    assert.match(events.find(item => item.action === 'live_room_discovery')?.reason || '', /自动发现 1 个/);
    assert.equal(calls.some(url => url.includes('following')), true);
    assert.equal(calls.some(url => url.includes('roomid=2001')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('直播心跳使用 B 站要求的数字房间字段', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; let heartbeatBody: any; const controller = new AbortController();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/xlive/web-ucenter/user/following')) return jsonResponse({ code: 0, data: { list: [{ roomid: 2001, live_status: 1 }], totalPage: 1 } });
    if (url.includes('/room/v1/Room/get_info')) return jsonResponse({ code: 0, data: { uid: 9001, parent_area_id: 1, area_id: 2 } });
    if (url.includes('/xlive/data-interface/v1/heartbeat')) { heartbeatBody = JSON.parse(String(init?.body)); setTimeout(() => controller.abort(), 0); return jsonResponse({ code: 0, data: {} }); }
    return jsonResponse({ code: 0, data: { isLogin: true, mid: 42 } });
  }) as typeof fetch;
  try {
    const config = structuredClone(defaultDailyConfig);
    config.liveAutomation = { ...config.liveAutomation, enabled: true, rooms: ['2001'], heartbeat: true, durationMinutes: 1 };
    config.requestDelay = 0; config.retryTimes = 0;
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', config);
    await client.runLiveAutomation(controller.signal, async () => undefined);
    assert.equal(typeof heartbeatBody.room_id, 'number');
    assert.equal(typeof heartbeatBody.seq_id, 'number');
    assert.equal(typeof heartbeatBody.up_id, 'number');
    assert.equal(typeof heartbeatBody.jump_from, 'string');
  } finally { globalThis.fetch = originalFetch; }
});

test('带目标的每日动作只保存一次请求尝试', { concurrency: false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lottery-daily-attempt-dedupe-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 9013 } });
    if (url.includes('/x/member/web/exp/reward')) return jsonResponse({ code: 0, data: { share: false } });
    if (url.includes('/x/web-interface/ranking/v2')) return jsonResponse({ code: 0, data: { list: [{ aid: 1, bvid: 'BV1dedupe', cid: 2, duration: 10, title: '尝试记录目标' }] } });
    if (url.includes('/x/share/finish')) return jsonResponse({ code: -500, message: '测试失败' });
    return jsonResponse({ code: -404, message: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    const db = await AppDatabase.create(join(directory, 'test.db'));
    const account = db.createAccount({ uid: '9013', cookie: encrypt('DedeUserID=9013; bili_jct=test') })!;
    const config = mergeDailyConfig({ experience: { share: true }, requestDelay: 0, retryTimes: 0 });
    const result = await new DailyTaskRunner(db).run(account, 42, config, { actions: ['share_video'] });
    assert.equal(result.code, 1);
    const attempts = db.listDailyActionAttempts(42) as any[];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].target_id, 'BV1dedupe');
    assert.equal(attempts[0].provider_code, -500);
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('投币遵守今日上限、余额保护并记录目标视频', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 42, money: 5 } });
    if (url.includes('/coin/today/exp')) return jsonResponse({ code: 0, data: 0 });
    if (url.includes('/ranking/v2')) return jsonResponse({ code: 0, data: { list: [{ aid: 123, bvid: 'BV1coin', cid: 456, duration: 20, title: '投币目标' }] } });
    if (url.includes('/archive/coins')) return jsonResponse({ code: 0, data: { multiply: 0 } });
    if (url.includes('/coin/add')) return jsonResponse({ code: 0, message: '0' });
    return jsonResponse({ code: -404, message: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    const config = mergeDailyConfig({ experience: { coin: true, coinLimit: 1, protectedCoins: 4, likeWhenCoin: true }, retryTimes: 0, requestDelay: 0 });
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', config);
    await client.validate();
    const outcome = await client.coinVideo();
    assert.equal(outcome.result.status, 'success');
    assert.equal(outcome.details?.[0].targetId, 'BV1coin');
    const coin = calls.find(call => call.url.endsWith('/x/web-interface/coin/add'))!;
    const body = new URLSearchParams(String(coin.init?.body));
    assert.equal(body.get('multiply'), '1');
    assert.equal(body.get('select_like'), '1');
  } finally { globalThis.fetch = originalFetch; }
});

test('HTTP 限流和重复签到保存真实状态且不暴露 Cookie', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => jsonResponse({ code: -412, message: '请求被拦截' }, 429)) as typeof fetch;
    const limited = await new DailyBiliClient('SESSDATA=secret; bili_jct=csrf', mergeDailyConfig({ retryTimes: 0 })).validate();
    assert.equal(limited.result.errorType, 'http');
    assert.equal(limited.result.httpStatus, 429);
    assert.equal(limited.result.status, 'throttled');
    assert.equal(limited.result.retryable, false);
    assert.equal(limited.result.reason.includes('secret'), false);

    globalThis.fetch = (async () => jsonResponse({ code: -400, message: '今日已签到' }, 400)) as typeof fetch;
    const signed = await new DailyBiliClient('SESSDATA=secret; bili_jct=csrf', mergeDailyConfig({ retryTimes: 0 })).mangaSign();
    assert.equal(signed.result.status, 'completed');
    assert.match(signed.result.reason, /已签到/);
  } finally { globalThis.fetch = originalFetch; }
});

test('VIP 大积分只执行签到和已确认的安全任务', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 42, vipStatus: 1 } });
    if (url.includes('/three_days_sign')) return jsonResponse({ code: 0, data: { three_day_sign: { signed: false } } });
    if (url.includes('/task/sign2')) return jsonResponse({ code: 0, data: { score: 5 } });
    if (url.includes('/task/combine')) return jsonResponse({ code: 0, data: { task_info: { modules: [{ common_task_item: [
      { task_code: 'bonus', title: '福利任务', state: 0 },
      { task_code: 'dress-view', title: '浏览装扮商城', state: 1 },
      { task_code: 'buy-task', title: '购买任务', state: 0 }
    ] }] } } });
    if (url.includes('/task/receive/v2')) return jsonResponse({ code: 0, data: {} });
    if (url.endsWith('/pgc/activity/score/task/complete')) return jsonResponse({ code: 0, data: {} });
    if (url.includes('/task/complete/v2')) return jsonResponse({ code: 0, data: {} });
    return jsonResponse({ code: -404, message: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value; buvid3=buvid-value', mergeDailyConfig({ vipBigPoint: { enabled: true }, retryTimes: 0, requestDelay: 0 }));
    await client.validate();
    const outcome = await client.vipBigPoint();
    assert.equal(outcome.result.status, 'success');
    assert.deepEqual(outcome.details?.map(item => item.targetId), ['sign', 'bonus', 'dress-view']);
    const sign = calls.find(call => call.url.includes('/task/sign2'))!;
    assert.equal(sign.init?.headers && (sign.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.deepEqual(Object.keys(JSON.parse(String(sign.init?.body))).sort(), ['device', 't', 'ts']);
    const receive = calls.find(call => call.url.includes('/task/receive/v2'))!;
    assert.equal(new URLSearchParams(String(receive.init?.body)).get('taskCode'), 'bonus');
    assert.equal(calls.some(call => String(call.init?.body || '').includes('buy-task')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('粉丝勋章分页扫描且只为正在直播的未完成任务点赞', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 42 } });
    if (url.includes('/fansMedal/panel?page=1')) return jsonResponse({ code: 0, data: { special_list: [], list: [{ medal: { target_id: 101, medal_name: '离线牌' }, room_info: { room_id: 201 }, anchor_info: { nick_name: '离线主播' } }], page_info: { has_more: true, total_page: 2 } } });
    if (url.includes('/fansMedal/panel?page=2')) return jsonResponse({ code: 0, data: { special_list: [], list: [{ medal: { target_id: 102, medal_name: '直播牌' }, room_info: { room_id: 202 }, anchor_info: { nick_name: '直播主播' } }], page_info: { has_more: false, total_page: 2 } } });
    if (url.includes('/GetActivatedMedalInfo')) return jsonResponse({ code: 0, data: { is_lighted: false, reach_free_intimacy_limit: false, task_info: [{ jump_type: 'like', title: '点赞1次', sub_title: '0/2', is_done: false }] } });
    if (url.includes('room_id=201')) return jsonResponse({ code: 0, data: { live_status: 0 } });
    if (url.includes('room_id=202')) return jsonResponse({ code: 0, data: { live_status: 1 } });
    if (url.includes('/likeReportV3')) return jsonResponse({ code: 0, data: {} });
    return jsonResponse({ code: -404, message: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', mergeDailyConfig({ fansMedal: { enabled: true, maxActions: 2 }, retryTimes: 0, requestDelay: 0 }));
    await client.validate();
    const outcome = await client.fansMedal();
    assert.equal(outcome.result.status, 'success');
    assert.equal(outcome.details?.find(item => item.targetId === '101')?.result.status, 'skipped');
    assert.equal(outcome.details?.find(item => item.targetId === '102')?.result.status, 'success');
    const like = calls.find(call => call.url.includes('/likeReportV3'))!;
    const form = new URLSearchParams(String(like.init?.body));
    assert.equal(form.get('click_time'), '2');
    assert.equal(form.get('room_id'), '202');
    assert.equal(form.get('anchor_id'), '102');
    assert.equal(form.get('uid'), '42');
  } finally { globalThis.fetch = originalFetch; }
});

test('粉丝勋章响应格式异常时不发送点赞请求', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch; const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.includes('/x/web-interface/nav')) return jsonResponse({ code: 0, data: { isLogin: true, mid: 42 } });
    return jsonResponse({ code: 0, data: { list: [] } });
  }) as typeof fetch;
  try {
    const client = new DailyBiliClient('DedeUserID=42; bili_jct=csrf-value', mergeDailyConfig({ fansMedal: { enabled: true }, retryTimes: 0 }));
    await client.validate();
    const outcome = await client.fansMedal();
    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.result.errorType, 'parse');
    assert.equal(calls.some(url => url.includes('/likeReportV3')), false);
  } finally { globalThis.fetch = originalFetch; }
});
