import { decrypt } from './security';
import type { AccountRow, AppDatabase, DailyActionInput } from './db';
import { DailyBiliClient, type DailyActionOutcome, type DailyResult } from './daily-bili';

export type DailyConfig = {
  enabled: boolean;
  experience: { watch: boolean; share: boolean; coin: boolean; likeWhenCoin: boolean; coinLimit: number; protectedCoins: number; donateArticle: boolean; devicePlatform: 'android' | 'ios' };
  liveLottery: { enabled: boolean; maxPerDay: number; includeKeywords: string[]; excludeKeywords: string[] };
  vipBigPoint: { enabled: boolean; viewBangumis: string[] };
  fansMedal: { enabled: boolean; maxActions: number };
  manga: { enabled: boolean; sign: boolean; read: boolean };
  mangaPrivilege: { enabled: boolean };
  silver2Coin: { enabled: boolean; maxExchanges: number };
  charge: { enabled: boolean; targetUid: string; maxPerDay: number };
  vipPrivilege: { enabled: boolean };
  signIns: { live: boolean; supportGroups: boolean; vipExperience: boolean; mangaShare: boolean };
  resourceTasks: {
    bigPointExchange: boolean; bigPointToken: string; bigPointPrice: number;
    mangaPointExchange: boolean; mangaProductId: number; mangaPointCost: number; mangaQuantity: number;
    giftDelivery: boolean; giftRoomId: string; giftReceiverUid: string; giftExpireHours: number; giftMaxCount: number;
    liveWeeklyReward: boolean; dailyBattery: boolean; dailyBatteryRoomIds: string[]; dailyBatteryMaxActions: number;
  };
  community: {
    activityLottery: boolean; activityIds: string[]; activityMaxDraws: number;
    matchGuess: boolean; matchCoins: number; matchMax: number; matchMinOddsDiff: number;
    jury: boolean; juryMaxCases: number; juryAutoApply: boolean;
    reservation: boolean; reservationUids: string[]; reservationIds: string[]; reservationMax: number;
    blacklistCleanup: boolean; blacklistMax: number;
  };
  liveAutomation: {
    enabled: boolean; rooms: string[]; durationMinutes: number; redPackets: boolean; intimacy: boolean;
    danmaku: boolean; heartbeat: boolean; messages: string[]; maxRedPackets: number; maxDanmaku: number;
  };
  streaming: { enabled: boolean; mediaId: number | null; areaId: number; title: string; maxDurationMinutes: number };
  requestDelay: number;
  retryTimes: number;
  riskControl: { pauseOnRisk: boolean; pauseMinutes: number };
};

export const defaultDailyConfig: DailyConfig = {
  enabled: true,
  experience: { watch: false, share: false, coin: false, likeWhenCoin: false, coinLimit: 0, protectedCoins: 0, donateArticle: false, devicePlatform: 'android' },
  liveLottery: { enabled: false, maxPerDay: 4, includeKeywords: [], excludeKeywords: ['舰', '船', '航海', '代金券', '自拍', '照', '写真', '图', '提督'] },
  vipBigPoint: { enabled: false, viewBangumis: ['33378'] },
  fansMedal: { enabled: false, maxActions: 3 },
  manga: { enabled: false, sign: false, read: false },
  mangaPrivilege: { enabled: false },
  silver2Coin: { enabled: false, maxExchanges: 1 },
  charge: { enabled: false, targetUid: '', maxPerDay: 1 },
  vipPrivilege: { enabled: false },
  signIns: { live: false, supportGroups: false, vipExperience: false, mangaShare: false },
  resourceTasks: {
    bigPointExchange: false, bigPointToken: '', bigPointPrice: 0,
    mangaPointExchange: false, mangaProductId: 195, mangaPointCost: 100, mangaQuantity: 1,
    giftDelivery: false, giftRoomId: '', giftReceiverUid: '', giftExpireHours: 72, giftMaxCount: 5,
    liveWeeklyReward: false, dailyBattery: false, dailyBatteryRoomIds: [], dailyBatteryMaxActions: 5
  },
  community: {
    activityLottery: false, activityIds: [], activityMaxDraws: 3,
    matchGuess: false, matchCoins: 1, matchMax: 3, matchMinOddsDiff: 0,
    jury: false, juryMaxCases: 3, juryAutoApply: false,
    reservation: false, reservationUids: [], reservationIds: [], reservationMax: 10,
    blacklistCleanup: false, blacklistMax: 20
  },
  liveAutomation: {
    enabled: false, rooms: [], durationMinutes: 30, redPackets: false, intimacy: false,
    danmaku: false, heartbeat: false, messages: ['打卡'], maxRedPackets: 10, maxDanmaku: 3
  },
  streaming: { enabled: false, mediaId: null, areaId: 0, title: '', maxDurationMinutes: 60 },
  requestDelay: 1500,
  retryTimes: 2,
  riskControl: { pauseOnRisk: true, pauseMinutes: 60 }
};

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clone(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}

function list(value: unknown) { return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : String(value || '').split(/[,，\n]+/).map(item => item.trim()).filter(Boolean); }

export function mergeDailyConfig(override: unknown = {}, inherited: unknown = {}): DailyConfig {
  const input = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {});
  const base = clone(defaultDailyConfig) as any;
  const merge = (value: unknown) => {
    const source = input(value);
    for (const [key, child] of Object.entries(source)) {
      if (child && typeof child === 'object' && !Array.isArray(child) && base[key] && typeof base[key] === 'object') base[key] = { ...base[key], ...child };
      else if (key in base) base[key] = child;
    }
  };
  merge(inherited); merge(override);
  base.experience.coinLimit = Math.max(0, Math.min(5, Math.round(Number(base.experience.coinLimit) || 0)));
  base.experience.protectedCoins = Math.max(0, Math.round(Number(base.experience.protectedCoins) || 0));
  base.liveLottery.maxPerDay = Math.max(0, Math.min(20, Math.round(Number(base.liveLottery.maxPerDay) || 0)));
  base.fansMedal.maxActions = Math.max(0, Math.min(20, Math.round(Number(base.fansMedal.maxActions) || 0)));
  base.silver2Coin.maxExchanges = Math.max(0, Math.min(20, Math.round(Number(base.silver2Coin.maxExchanges) || 0)));
  base.charge.maxPerDay = Math.max(0, Math.min(5, Math.round(Number(base.charge.maxPerDay) || 0)));
  base.resourceTasks.bigPointToken = String(base.resourceTasks.bigPointToken || '').trim();
  base.resourceTasks.bigPointPrice = Math.max(0, Math.round(Number(base.resourceTasks.bigPointPrice) || 0));
  base.resourceTasks.mangaProductId = Math.max(1, Math.round(Number(base.resourceTasks.mangaProductId) || 195));
  base.resourceTasks.mangaPointCost = Math.max(1, Math.round(Number(base.resourceTasks.mangaPointCost) || 100));
  base.resourceTasks.mangaQuantity = Math.max(1, Math.min(10, Math.round(Number(base.resourceTasks.mangaQuantity) || 1)));
  base.resourceTasks.giftRoomId = String(base.resourceTasks.giftRoomId || '').trim();
  base.resourceTasks.giftReceiverUid = String(base.resourceTasks.giftReceiverUid || '').trim();
  base.resourceTasks.giftExpireHours = Math.max(1, Math.min(720, Math.round(Number(base.resourceTasks.giftExpireHours) || 72)));
  base.resourceTasks.giftMaxCount = Math.max(1, Math.min(100, Math.round(Number(base.resourceTasks.giftMaxCount) || 5)));
  base.resourceTasks.dailyBatteryRoomIds = list(base.resourceTasks.dailyBatteryRoomIds);
  base.resourceTasks.dailyBatteryMaxActions = Math.max(1, Math.min(20, Math.round(Number(base.resourceTasks.dailyBatteryMaxActions) || 5)));
  base.community.activityIds = list(base.community.activityIds);
  base.community.activityMaxDraws = Math.max(1, Math.min(20, Math.round(Number(base.community.activityMaxDraws) || 3)));
  base.community.matchCoins = Math.max(1, Math.min(10, Math.round(Number(base.community.matchCoins) || 1)));
  base.community.matchMax = Math.max(1, Math.min(20, Math.round(Number(base.community.matchMax) || 3)));
  base.community.matchMinOddsDiff = Math.max(0, Math.min(100, Number(base.community.matchMinOddsDiff) || 0));
  base.community.juryMaxCases = Math.max(1, Math.min(20, Math.round(Number(base.community.juryMaxCases) || 3)));
  base.community.reservationUids = list(base.community.reservationUids);
  base.community.reservationIds = list(base.community.reservationIds);
  base.community.reservationMax = Math.max(1, Math.min(50, Math.round(Number(base.community.reservationMax) || 10)));
  base.community.blacklistMax = Math.max(1, Math.min(100, Math.round(Number(base.community.blacklistMax) || 20)));
  base.liveAutomation.rooms = list(base.liveAutomation.rooms);
  base.liveAutomation.messages = list(base.liveAutomation.messages);
  base.liveAutomation.durationMinutes = Math.max(1, Math.min(360, Math.round(Number(base.liveAutomation.durationMinutes) || 30)));
  base.liveAutomation.maxRedPackets = Math.max(1, Math.min(50, Math.round(Number(base.liveAutomation.maxRedPackets) || 10)));
  base.liveAutomation.maxDanmaku = Math.max(1, Math.min(20, Math.round(Number(base.liveAutomation.maxDanmaku) || 3)));
  base.streaming.mediaId = Number.isInteger(Number(base.streaming.mediaId)) && Number(base.streaming.mediaId) > 0 ? Number(base.streaming.mediaId) : null;
  base.streaming.areaId = Math.max(0, Math.round(Number(base.streaming.areaId) || 0));
  base.streaming.title = String(base.streaming.title || '').trim().slice(0, 40);
  base.streaming.maxDurationMinutes = Math.max(1, Math.min(360, Math.round(Number(base.streaming.maxDurationMinutes) || 60)));
  base.requestDelay = Math.max(0, Math.min(600000, Math.round(Number(base.requestDelay) || 0)));
  base.retryTimes = Math.max(0, Math.min(5, Math.round(Number(base.retryTimes) || 0)));
  base.experience.devicePlatform = base.experience.devicePlatform === 'ios' ? 'ios' : 'android';
  base.experience.donateArticle = false;
  base.liveLottery.includeKeywords = list(base.liveLottery.includeKeywords);
  base.liveLottery.excludeKeywords = list(base.liveLottery.excludeKeywords);
  base.vipBigPoint.viewBangumis = list(base.vipBigPoint.viewBangumis);
  base.charge.targetUid = String(base.charge.targetUid || '').trim();
  base.riskControl.pauseOnRisk = base.riskControl.pauseOnRisk !== false;
  base.riskControl.pauseMinutes = Math.max(1, Math.min(1440, Math.round(Number(base.riskControl.pauseMinutes) || 60)));
  return base as DailyConfig;
}

export function validateDailyConfig(value: unknown, inherited: unknown = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('每日任务配置必须是对象');
  const normalized = mergeDailyConfig(value, inherited);
  if (normalized.charge.enabled && !/^\d+$/.test(normalized.charge.targetUid)) throw new Error('B 币券充电已启用时必须填写目标 UP 主 UID');
  if (normalized.resourceTasks.bigPointExchange && !normalized.resourceTasks.bigPointToken) throw new Error('大积分兑换已启用时必须填写商品 Token');
  if (normalized.resourceTasks.giftDelivery && (!/^\d+$/.test(normalized.resourceTasks.giftRoomId) || !/^\d+$/.test(normalized.resourceTasks.giftReceiverUid))) throw new Error('临期礼物投喂已启用时必须填写直播间 ID 和接收人 UID');
  if (normalized.streaming.enabled && (!normalized.streaming.mediaId || !normalized.streaming.areaId)) throw new Error('自动开播已启用时必须选择素材并填写直播分区 ID');
  return normalized;
}

export function dailyConfigDiff(value: unknown, inherited: unknown = {}) {
  const normalized = validateDailyConfig(value, inherited); const base = mergeDailyConfig({}, inherited); const diff: Record<string, any> = {};
  for (const key of Object.keys(normalized) as Array<keyof DailyConfig>) {
    if (JSON.stringify(normalized[key]) !== JSON.stringify((base as any)[key])) diff[key] = clone(normalized[key]);
  }
  return { normalized, diff };
}

function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()); }

export const dailyActionSupport: Record<string, { supported: boolean; note?: string }> = {
  daily_login: { supported: true }, watch_video: { supported: true }, share_video: { supported: true }, coin_video: { supported: true },
  live_lottery: { supported: true }, manga_sign: { supported: true }, manga_read: { supported: true }, manga_privilege: { supported: true },
  silver_to_coin: { supported: true }, charge: { supported: true }, vip_privilege: { supported: true },
  vip_big_point: { supported: true, note: '执行会员签到和已确认的安全积分任务，不执行购买任务' },
  fans_medal: { supported: true, note: '仅对正在直播且点赞任务未完成的粉丝勋章发送点赞' }
  ,live_sign: { supported: true }, support_group_sign: { supported: true }, vip_experience: { supported: true }, manga_share: { supported: true },
  big_point_exchange: { supported: true }, manga_point_exchange: { supported: true }, expiring_gift: { supported: true }, live_weekly_reward: { supported: true }, daily_battery: { supported: true },
  activity_lottery: { supported: true }, match_guess: { supported: true }, jury_vote: { supported: true }, live_reservation: { supported: true }, blacklist_cleanup: { supported: true }
};

export const dailyCatalog = [
  { group: 'experience', label: '每日经验', actions: ['watch_video', 'share_video', 'coin_video'] },
  { group: 'membership', label: '会员与漫画', actions: ['vip_big_point', 'manga_sign', 'manga_read', 'manga_share', 'manga_privilege', 'vip_privilege', 'vip_experience'] },
  { group: 'live', label: '直播任务', actions: ['live_sign', 'support_group_sign', 'live_lottery', 'fans_medal', 'live_weekly_reward', 'daily_battery'] },
  { group: 'resources', label: '兑换与资源', actions: ['silver_to_coin', 'charge', 'big_point_exchange', 'manga_point_exchange', 'expiring_gift'] },
  { group: 'community', label: '社区与活动', actions: ['activity_lottery', 'match_guess', 'jury_vote', 'live_reservation', 'blacklist_cleanup'] }
] as const;

export const dailyActionLabels: Record<string, string> = {
  daily_login: '账号状态检查', watch_video: '观看视频', share_video: '分享视频', coin_video: '视频投币', live_lottery: '直播天选抽奖',
  vip_big_point: 'VIP 大积分', fans_medal: '粉丝勋章', manga_sign: '漫画签到', manga_read: '漫画阅读', manga_privilege: '漫画权益',
  silver_to_coin: '银瓜子兑换硬币', charge: 'B 币券充电', vip_privilege: 'VIP 权益', live_sign: '直播签到', support_group_sign: '应援团签到',
  vip_experience: 'VIP 经验礼包', manga_share: '漫画分享', big_point_exchange: '大积分兑换', manga_point_exchange: '漫画积分兑换',
  expiring_gift: '临期礼物投喂', live_weekly_reward: '直播每周奖励', daily_battery: '每日电池', activity_lottery: '活动转盘',
  match_guess: '电竞竞猜', jury_vote: '社区众议院', live_reservation: '直播预约', blacklist_cleanup: '黑名单清理',
  live_automation: '长运行直播任务', streaming: '自动开播'
};

export const riskyDailyActions = ['coin_video', 'live_lottery', 'silver_to_coin', 'charge', 'big_point_exchange', 'manga_point_exchange', 'expiring_gift', 'activity_lottery', 'match_guess', 'jury_vote', 'live_reservation', 'blacklist_cleanup'] as const;

export class DailyTaskRunner {
  constructor(private db: AppDatabase) {}

  preview(account: AccountRow, config: DailyConfig, selectedActions: string[] = []) {
    const taskDate = today(); const actions = [
      ['daily_login', true], ['watch_video', config.experience.watch], ['share_video', config.experience.share], ['coin_video', config.experience.coin],
      ['live_lottery', config.liveLottery.enabled], ['vip_big_point', config.vipBigPoint.enabled], ['fans_medal', config.fansMedal.enabled],
      ['manga_sign', config.manga.enabled && config.manga.sign], ['manga_read', config.manga.enabled && config.manga.read], ['manga_privilege', config.mangaPrivilege.enabled],
      ['silver_to_coin', config.silver2Coin.enabled], ['charge', config.charge.enabled], ['vip_privilege', config.vipPrivilege.enabled],
      ['live_sign', config.signIns.live], ['support_group_sign', config.signIns.supportGroups], ['vip_experience', config.signIns.vipExperience], ['manga_share', config.signIns.mangaShare],
      ['big_point_exchange', config.resourceTasks.bigPointExchange], ['manga_point_exchange', config.resourceTasks.mangaPointExchange], ['expiring_gift', config.resourceTasks.giftDelivery],
      ['live_weekly_reward', config.resourceTasks.liveWeeklyReward], ['daily_battery', config.resourceTasks.dailyBattery],
      ['activity_lottery', config.community.activityLottery], ['match_guess', config.community.matchGuess], ['jury_vote', config.community.jury],
      ['live_reservation', config.community.reservation], ['blacklist_cleanup', config.community.blacklistCleanup]
    ].map(([action, enabled]) => { const name = String(action); const existing = this.db.getDailyAction(account.id, taskDate, name); const selected = !selectedActions.length || selectedActions.includes(name); return { action: name, enabled: Boolean(enabled) && selected, configured: Boolean(enabled), selected, completed: ['success', 'completed'].includes(String(existing?.status || '')), existing, risky: (riskyDailyActions as readonly string[]).includes(name), ...(dailyActionSupport[name] || { supported: false, note: '当前版本未实现' }) }; });
    return { accountId: account.id, taskDate, enabled: config.enabled, actions };
  }

  async previewRemote(account: AccountRow, config: DailyConfig, selectedActions: string[] = []) {
    const preview = this.preview(account, config, selectedActions);
    const accountStatus = await new DailyBiliClient(decrypt(account.cookie), config).validate();
    return { ...preview, accountStatus: accountStatus.result };
  }

  async run(account: AccountRow, runId: number, config: DailyConfig, options: Record<string, unknown> = {}): Promise<{ code: number; discovered: number; candidates: number; attempted: number; success: number; partial: number; failed: number; errors: number }> {
    const selectedActions = Array.isArray(options.actions) ? options.actions.map(String) : [];
    const taskDate = today(); const preview = this.preview(account, config, selectedActions); let attempted = 0; let success = 0; let failed = 0; let skipped = 0; const started = new Date().toISOString();
    const record = async (action: string, result: DailyResult, targetId = '', attemptCount = 0) => { const row = this.db.upsertDailyAction(account.id, runId, taskDate, { action, targetId, status: result.status, providerCode: result.providerCode, providerMessage: result.providerMessage, errorType: result.errorType, httpStatus: result.httpStatus, transportCode: result.transportCode, retryable: result.retryable, attemptCount: result.attemptCount || attemptCount, reason: result.reason, startedAt: started, finishedAt: new Date().toISOString() }); for (const [index, attempt] of (result.attempts || []).entries()) this.db.addDailyActionAttempt(account.id, runId, taskDate, action, targetId, index + 1, attempt); return row; };
    if (!config.enabled) { await record('daily', { status: 'skipped', reason: '每日任务总开关已关闭' }); return { code: 0, discovered: preview.actions.length, candidates: 0, attempted: 0, success: 0, partial: 0, failed: 0, errors: 0 }; }
    const runAction = async (action: string, enabled: boolean, fn: () => Promise<DailyActionOutcome>) => {
      enabled = enabled && (!selectedActions.length || selectedActions.includes(action));
      const existing = this.db.getDailyAction(account.id, taskDate, action); if (existing && ['success', 'completed'].includes(String(existing.status))) { skipped += 1; return; }
      if (!enabled) { skipped += 1; await record(action, { status: 'skipped', reason: '配置未启用，未发送写请求' }); return; }
      attempted += 1; const outcome = await fn();
      for (const detail of outcome.details || []) await record(action, detail.result, detail.targetId, detail.result.status === 'failed' ? 1 : 0);
      if (outcome.targetId) await record(action, outcome.result, outcome.targetId, outcome.result.status === 'failed' ? 1 : 0);
      await record(action, outcome.result, '', outcome.result.status === 'failed' ? 1 : 0);
      if (['success', 'completed'].includes(outcome.result.status)) success += 1; else if (['failed', 'throttled'].includes(outcome.result.status)) failed += 1; else skipped += 1;
    };
    const client = new DailyBiliClient(decrypt(account.cookie), config);
    const nav = await client.validate(); await record('daily_login', nav.result); if (nav.ok) success += 1; else { failed += 1; for (const [action, enabled] of preview.actions.filter(item => item.action !== 'daily_login').map(item => [String(item.action), Boolean(item.enabled)] as const)) if (enabled) { skipped += 1; await record(action, { status: 'skipped', reason: '账号状态检查失败，未发送写请求' }); } return { code: 1, discovered: preview.actions.length, candidates: 0, attempted: 1, success, partial: 0, failed, errors: 1 }; }
    await runAction('watch_video', config.experience.watch, () => client.watchVideo());
    await runAction('share_video', config.experience.share, () => client.shareVideo());
    await runAction('coin_video', config.experience.coin, () => client.coinVideo());
    await runAction('live_lottery', config.liveLottery.enabled, () => client.liveLottery());
    await runAction('vip_big_point', config.vipBigPoint.enabled, () => client.vipBigPoint());
    await runAction('fans_medal', config.fansMedal.enabled, () => client.fansMedal());
    await runAction('manga_sign', config.manga.enabled && config.manga.sign, () => client.mangaSign());
    await runAction('manga_read', config.manga.enabled && config.manga.read, () => client.mangaRead());
    await runAction('manga_privilege', config.mangaPrivilege.enabled, () => client.mangaPrivilege());
    await runAction('silver_to_coin', config.silver2Coin.enabled, () => client.silverToCoin());
    await runAction('charge', config.charge.enabled, () => client.charge());
    await runAction('vip_privilege', config.vipPrivilege.enabled, () => client.vipPrivilege());
    await runAction('live_sign', config.signIns.live, () => client.liveSign());
    await runAction('support_group_sign', config.signIns.supportGroups, () => client.supportGroupSign());
    await runAction('vip_experience', config.signIns.vipExperience, () => client.vipExperience());
    await runAction('manga_share', config.signIns.mangaShare, () => client.mangaShare());
    await runAction('big_point_exchange', config.resourceTasks.bigPointExchange, () => client.bigPointExchange());
    await runAction('manga_point_exchange', config.resourceTasks.mangaPointExchange, () => client.mangaPointExchange());
    await runAction('expiring_gift', config.resourceTasks.giftDelivery, () => client.expiringGift());
    await runAction('live_weekly_reward', config.resourceTasks.liveWeeklyReward, () => client.liveWeeklyReward());
    await runAction('daily_battery', config.resourceTasks.dailyBattery, () => client.dailyBattery());
    await runAction('activity_lottery', config.community.activityLottery, () => client.activityLottery());
    await runAction('match_guess', config.community.matchGuess, () => client.matchGuess());
    await runAction('jury_vote', config.community.jury, () => client.juryVote());
    await runAction('live_reservation', config.community.reservation, () => client.liveReservation());
    await runAction('blacklist_cleanup', config.community.blacklistCleanup, () => client.blacklistCleanup());
    return { code: failed ? 1 : 0, discovered: preview.actions.length, candidates: attempted, attempted, success, partial: 0, failed, errors: failed };
  }
}
