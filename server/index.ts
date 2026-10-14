import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { AppDatabase } from './db';
import { decrypt, encrypt, verifyPassword } from './security';
import { createQrSession, listRelationTags, pollQrSession, verifyBiliCookie } from './bili';
import { SerialScheduler } from './scheduler';
import { diffFromBase, diffFromDefaults, publicConfigPayload } from './config';
import { UpdateService } from './updater';
import { AiService } from './ai';
import { AccountScheduleService, nextScheduleRun, scheduleJobTypes } from './account-schedules';
import { EmailNotificationService } from './notifications';
import { AccountVerifier } from './account-verifier';
import { LotteryEnricher } from './lottery-enricher';
import { dailyActionLabels, dailyCatalog, dailyConfigDiff, defaultDailyConfig, mergeDailyConfig, riskyDailyActions, type DailyConfig } from './daily';
import { ffmpegStatus, mediaDirectory, probeMedia, removeMediaFile, safeMediaName } from './live-tasks';

async function bootstrap() {
const app = Fastify({ logger: false });
const db = await AppDatabase.create();
function readGlobalConfig() { try { return JSON.parse(db.getSetting('global_config') || '{}') as Record<string, unknown>; } catch { return {}; } }
function migrateLegacyCleanupDays() {
  const globalConfig = readGlobalConfig();
  if (Object.prototype.hasOwnProperty.call(globalConfig, 'clear_max_day') && Number(globalConfig.clear_max_day) < 1) {
    globalConfig.clear_max_day = 30; db.setSetting('global_config', JSON.stringify(globalConfig));
  }
  for (const account of db.listAccounts()) {
    const accountConfig = db.getConfig(account.id) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(accountConfig, 'clear_max_day') && Number(accountConfig.clear_max_day) < 1) {
      accountConfig.clear_max_day = 30; db.setConfig(account.id, accountConfig);
    }
  }
}
migrateLegacyCleanupDays();
db.normalizeForcedCommentConfig();
try { const normalized = diffFromDefaults(readGlobalConfig()).diff; db.setSetting('global_config', JSON.stringify(normalized)); }
catch { db.setSetting('global_config', '{}'); }
const ai = new AiService(db);
const notifications = new EmailNotificationService(db);
const scheduler = new SerialScheduler(db, ai, notifications);
const verifier = new AccountVerifier(db, notifications, () => scheduler.beginMaintenance(), () => scheduler.endMaintenance());
const enricher = new LotteryEnricher(db, () => scheduler.beginMaintenance(), () => scheduler.endMaintenance());
const accountSchedules = new AccountScheduleService(db, scheduler);
const updater = new UpdateService(db);
const sessions = new Set<string>();
const qrSessions = new Map<string, { key: string; expires: number }>();

await app.register(cookie);
await app.register(cors, { origin: true, credentials: true });
await app.register(multipart, { limits: { files: 1, fileSize: 2 * 1024 * 1024 * 1024, fields: 5 } });
app.addContentTypeParser(['application/gzip', 'application/octet-stream'], { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

async function auth(request: any, reply: any) { if (!sessions.has(request.cookies.admin_session)) return reply.code(401).send({ error: '未登录' }); }
function publicAccount(account: any) { if (!account) return account; const { cookie: _cookie, ...safe } = account; return { ...safe, profile: safe.profile_json ? JSON.parse(safe.profile_json) : null }; }
function parseId(value: string) { const id = Number(value); if (!Number.isInteger(id) || id < 1) throw new Error('无效 ID'); return id; }
const cleanupKeys = ['clear_max_day', 'clear_partition', 'clear_white_list', 'clear_remove_dynamic', 'clear_remove_attention', 'clear_remove_delay'] as const;
function cleanupPayload(scope: 'default' | 'account', accountId?: number) {
  const inherited = readGlobalConfig();
  const override = scope === 'account' && accountId ? db.getConfig(accountId) as Record<string, unknown> : inherited;
  const payload = publicConfigPayload(override, scope === 'account' ? inherited : {}, scope);
  const pick = (value: Record<string, any>) => Object.fromEntries(cleanupKeys.map(key => [key, value[key]]));
  const schedules = scope === 'account' && accountId ? accountSchedules.listAccount(accountId) : accountSchedules.listDefaults();
  return {
    scope,
    inherited: scope === 'account' ? !cleanupKeys.some(key => Object.prototype.hasOwnProperty.call(override, key)) : false,
    effective: pick(payload.effective),
    overrides: pick(payload.overrides),
    defaults: pick(payload.defaults),
    schedule: schedules.find(item => item.type === 'clear') || null
  };
}
function cleanupInput(body: any) {
  const result: Record<string, unknown> = {};
  for (const key of cleanupKeys) if (body?.[key] !== undefined) result[key] = body[key];
  return result;
}

app.post('/api/auth/login', async (request, reply) => {
  const body = request.body as { password?: string };
  if (!body?.password || !verifyPassword(body.password, db.getSetting('admin_password_hash')!)) return reply.code(401).send({ error: '密码错误' });
  const token = randomBytes(32).toString('hex'); sessions.add(token); reply.setCookie('admin_session', token, { httpOnly: true, sameSite: 'lax', path: '/' }); return { ok: true };
});
app.post('/api/auth/logout', { preHandler: auth }, async (request, reply) => { sessions.delete(request.cookies.admin_session); reply.clearCookie('admin_session', { path: '/' }); return { ok: true }; });
app.get('/api/auth/me', { preHandler: auth }, async () => ({ ok: true }));

app.get('/api/accounts', { preHandler: auth }, async () => db.listAccounts().map(publicAccount));
app.post('/api/accounts/cookie', { preHandler: auth }, async (request, reply) => {
  const body = request.body as { cookie?: string; note?: string };
  if (!body?.cookie?.includes('DedeUserID=')) return reply.code(400).send({ error: 'Cookie 至少需要包含 DedeUserID' });
  const verified = await verifyBiliCookie(body.cookie); if (!verified.ok) return reply.code(verified.kind === 'invalid' ? 400 : 502).send({ error: verified.error });
  const row = db.createAccount({ cookie: encrypt(body.cookie), note: body.note, uid: verified.profile.uid, name: verified.profile.name, profile: verified.profile });
  accountSchedules.ensureAccount(row!.id);
  return publicAccount(row);
});
app.patch('/api/accounts/:id', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); const row = db.updateAccount(id, request.body as any); if (!row) return reply.code(404).send({ error: '账号不存在' }); return publicAccount(row); });
app.delete('/api/accounts/:id', { preHandler: auth }, async (request) => { db.deleteAccount(parseId((request.params as any).id)); return { ok: true }; });
app.post('/api/accounts/:id/verify', { preHandler: auth }, async (request, reply) => {
  const result = await verifier.verifyOne(parseId((request.params as any).id));
  if (!result) return reply.code(404).send({ error: '账号不存在' });
  if ('busy' in result && result.busy) return reply.code(409).send(result);
  return result.ok ? result : reply.code('transient' in result && result.transient ? 502 : 400).send(result);
});
app.post('/api/accounts/verify-all', { preHandler: auth }, async (request, reply) => { const result = await verifier.verifyAll(); return result.busy ? reply.code(409).send({ error: '账号任务队列正在运行', ...result }) : result; });

app.post('/api/accounts/qr/start', { preHandler: auth }, async () => { const qr = await createQrSession(); const id = randomBytes(10).toString('hex'); qrSessions.set(id, { key: qr.key, expires: Date.now() + 180000 }); return { sessionId: id, image: qr.image, expiresAt: Date.now() + 180000 }; });
app.post('/api/accounts/qr/:sessionId/poll', { preHandler: auth }, async (request, reply) => { const session = qrSessions.get((request.params as any).sessionId); if (!session || session.expires < Date.now()) return reply.code(410).send({ status: 'expired' }); const result = await pollQrSession(session.key); if (result.status === 'success' && result.rawCookie) { const verified = await verifyBiliCookie(result.rawCookie); if (!verified.ok) return reply.code(verified.kind === 'invalid' ? 400 : 502).send(verified); const row = db.createAccount({ cookie: encrypt(result.rawCookie), uid: verified.profile.uid, name: verified.profile.name, profile: verified.profile }); accountSchedules.ensureAccount(row!.id); qrSessions.delete((request.params as any).sessionId); return { ...result, rawCookie: undefined, account: publicAccount(row) }; } return { ...result, rawCookie: undefined }; });

app.post('/api/accounts/:id/jobs', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  const body = (request.body || {}) as Record<string, any>; const type = body.type || 'start';
  if (!['start', 'discover', 'check', 'clear', 'account', 'comment_backfill', 'daily', 'live_automation', 'streaming'].includes(type)) return reply.code(400).send({ error: '不支持的任务类型' });
  try { return scheduler.enqueue(id, type, { ...(body.options || {}), ...(Array.isArray(body.actions) ? { actions: body.actions.map(String) } : {}) }); }
  catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get('/api/cleanup/config', { preHandler: auth }, async () => cleanupPayload('default'));
app.put('/api/cleanup/config', { preHandler: auth }, async (request, reply) => {
  try {
    const current = publicConfigPayload(readGlobalConfig(), {}, 'default').effective as Record<string, unknown>;
    const { diff } = diffFromDefaults({ ...current, ...cleanupInput(request.body) });
    db.setSetting('global_config', JSON.stringify(diff));
    return cleanupPayload('default');
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '清理配置无效' }); }
});
app.get('/api/accounts/:id/cleanup/config', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); return cleanupPayload('account', id);
});
app.get('/api/accounts/:id/cleanup/partitions', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id);
  const account = db.getAccount(id);
  if (!account) return reply.code(404).send({ error: '账号不存在' });
  if (account.cookie_status === 'invalid') return reply.code(400).send({ error: '账号 Cookie 已失效，请重新扫码登录' });
  const result = await listRelationTags(decrypt(account.cookie));
  if (!result.ok) return reply.code(result.kind === 'invalid' ? 400 : result.kind === 'rate_limited' ? 429 : 502).send({ error: result.error, kind: result.kind });
  const selected = new Set(String(cleanupPayload('account', id).effective.clear_partition || '').split(/[,，]+/).map(item => item.trim()).filter(Boolean));
  return { accountId: id, partitions: result.partitions.map(item => ({ ...item, selected: selected.has(item.name) })), selectedNames: [...selected] };
});
app.put('/api/accounts/:id/cleanup/config', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  try {
    const inherited = readGlobalConfig(); const existing = db.getConfig(id) as Record<string, unknown>;
    const current = publicConfigPayload(existing, inherited, 'account').effective as Record<string, unknown>;
    const { diff } = diffFromBase({ ...current, ...cleanupInput(request.body) }, inherited);
    if (existing.ai) diff.ai = existing.ai; if (existing.notifications) diff.notifications = existing.notifications;
    db.setConfig(id, diff); return cleanupPayload('account', id);
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '账号清理配置无效' }); }
});
app.post('/api/accounts/:id/cleanup/config/reset', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  const current = db.getConfig(id) as Record<string, unknown>; for (const key of cleanupKeys) delete current[key]; db.setConfig(id, current); return cleanupPayload('account', id);
});
app.post('/api/accounts/:id/cleanup/preview', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  return { accepted: true, job: scheduler.enqueue(id, 'clear_preview') };
});
app.post('/api/cleanup/preview', { preHandler: auth }, async () => {
  const accounts = db.listAccounts().filter(account => account.enabled);
  const jobs = accounts.map(account => scheduler.enqueue(account.id, 'clear_preview'));
  return { accepted: jobs.length > 0, jobs, accountCount: accounts.length, reason: jobs.length ? undefined : '没有启用的账号' };
});
app.post('/api/cleanup/run', { preHandler: auth }, async () => {
  const accounts = db.listAccounts().filter(account => account.enabled);
  const jobs = accounts.map(account => scheduler.enqueue(account.id, 'clear'));
  return { accepted: jobs.length > 0, jobs, accountCount: accounts.length, reason: jobs.length ? undefined : '没有启用的账号' };
});
function commentBackfillLimit(body: any) { return Math.min(100, Math.max(1, Number(body?.limit) || 20)); }
function commentBackfillPreview(accountId: number, limit: number) {
  return db.listCommentBackfillCandidates(accountId, limit).map(item => ({ dyid: item.dyid, author: item.author, description: item.description, url: item.url, originalParticipatedAt: item.finished_at, commentSource: '当前账号评论配置', attemptCount: Number(item.attempt_count) || 0, remainingAttempts: Math.max(0, 3 - (Number(item.attempt_count) || 0)) }));
}
app.get('/api/comment-backfill/status', { preHandler: auth }, async () => db.commentBackfillGlobalStats());
app.post('/api/comment-backfill/preview', { preHandler: auth }, async request => {
  const limit = commentBackfillLimit(request.body); const accounts = db.listAccounts().filter(account => account.enabled && account.cookie_status === 'valid');
  const results = accounts.map(account => ({ accountId: account.id, accountName: account.note || account.name || `账号 ${account.id}`, items: commentBackfillPreview(account.id, limit) })).filter(item => item.items.length);
  return { limit, accountCount: results.length, total: results.reduce((sum, item) => sum + item.items.length, 0), accounts: results };
});
app.post('/api/comment-backfill', { preHandler: auth }, async request => {
  const limit = commentBackfillLimit(request.body); const accounts = db.listAccounts().filter(account => account.enabled && account.cookie_status === 'valid');
  const jobs = accounts.filter(account => db.listCommentBackfillCandidates(account.id, 1).length > 0).map(account => scheduler.enqueue(account.id, 'comment_backfill', { limit }));
  return { accepted: jobs.length > 0, limit, accountCount: jobs.length, jobs, reason: jobs.length ? undefined : '没有当前可补充的评论记录' };
});
app.get('/api/accounts/:id/comment-backfill/status', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); return db.commentBackfillStats(id); });
app.post('/api/accounts/:id/comment-backfill/preview', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); const limit = commentBackfillLimit(request.body); return { items: commentBackfillPreview(id, limit), limit }; });
app.post('/api/accounts/:id/comment-backfill', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); const limit = Math.min(100, Math.max(1, Number((request.body as any)?.limit) || 20)); const candidates = db.listCommentBackfillCandidates(id, limit); if (!candidates.length) return { accepted: false, reason: '没有待补充评论的参与记录', pending: 0 }; return { accepted: true, limit, job: scheduler.enqueue(id, 'comment_backfill', { limit }) }; });
app.post('/api/jobs/:id/cancel', { preHandler: auth }, async (request) => ({ ok: scheduler.cancel(parseId((request.params as any).id)) }));
app.get('/api/jobs', { preHandler: auth }, async () => db.listJobs());
function readDailyGlobal() { try { return JSON.parse(db.getSetting('global_config') || '{}').daily_tasks || {}; } catch { return {}; } }
function dailyRiskFlags(config: DailyConfig): Record<string, boolean> {
  return {
    coin_video: config.experience.coin, live_lottery: config.liveLottery.enabled, silver_to_coin: config.silver2Coin.enabled, charge: config.charge.enabled,
    big_point_exchange: config.resourceTasks.bigPointExchange, manga_point_exchange: config.resourceTasks.mangaPointExchange, expiring_gift: config.resourceTasks.giftDelivery,
    activity_lottery: config.community.activityLottery, match_guess: config.community.matchGuess, jury_vote: config.community.jury,
    live_reservation: config.community.reservation, blacklist_cleanup: config.community.blacklistCleanup,
    live_automation: config.liveAutomation.enabled, streaming: config.streaming.enabled
  };
}
function missingDailyRiskConsents(scope: 'default' | 'account', accountId: number, current: DailyConfig, next: DailyConfig, confirmed: string[]) {
  const before = dailyRiskFlags(current); const after = dailyRiskFlags(next);
  return Object.keys(after).filter(action => after[action] && !before[action] && !db.hasDailyRiskConsent(scope, accountId, action) && !confirmed.includes(action));
}
function saveDailyRiskConsents(scope: 'default' | 'account', accountId: number, actions: string[]) { for (const action of actions) if ([...riskyDailyActions, 'live_automation', 'streaming'].includes(action as any)) db.saveDailyRiskConsent(scope, accountId, action); }
app.get('/api/daily/catalog', { preHandler: auth }, async () => ({ source: { name: 'BiliOutils', url: 'https://github.com/catlair/BiliOutils', license: 'MIT', integration: 'protocol-reference' }, groups: dailyCatalog.map(group => ({ ...group, actions: group.actions.map(action => ({ id: action, label: dailyActionLabels[action], risky: (riskyDailyActions as readonly string[]).includes(action) })) })), longActions: [{ id: 'live_automation', label: dailyActionLabels.live_automation, risky: true }, { id: 'streaming', label: dailyActionLabels.streaming, risky: true }] }));
app.get('/api/daily/config', { preHandler: auth }, async () => ({ scope: 'default', effective: mergeDailyConfig(readDailyGlobal()), defaults: defaultDailyConfig, inherited: false, riskConsents: db.listDailyRiskConsents('default', 0) }));
app.put('/api/daily/config', { preHandler: auth }, async (request, reply) => {
  try {
    const body = (request.body || {}) as Record<string, any>; const current = mergeDailyConfig(readDailyGlobal());
    const global = (() => { try { return JSON.parse(db.getSetting('global_config') || '{}') as Record<string, any>; } catch { return {}; } })();
    const { normalized, diff } = dailyConfigDiff(body.daily_tasks || body || {}, {}); const confirmed = Array.isArray(body.riskConfirmations) ? body.riskConfirmations.map(String) : [];
    const missing = missingDailyRiskConsents('default', 0, current, normalized, confirmed); if (missing.length) return reply.code(409).send({ error: '启用这些动作前需要确认风险', requiresConfirmation: missing.map(action => ({ action, label: dailyActionLabels[action] || action })) });
    saveDailyRiskConsents('default', 0, confirmed);
    if (Object.keys(diff).length) global.daily_tasks = diff; else delete global.daily_tasks;
    db.setSetting('global_config', JSON.stringify(global));
    return { scope: 'default', effective: normalized, defaults: defaultDailyConfig, inherited: false, riskConsents: db.listDailyRiskConsents('default', 0) };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '每日任务配置无效' }); }
});
app.post('/api/daily/config/apply-to-all', { preHandler: auth }, async () => ({ ok: true, accounts: db.resetAllDailyConfigs() }));
app.get('/api/daily/status', { preHandler: auth }, async () => ({ accounts: db.listAccounts().map(account => ({ accountId: account.id, accountName: account.name || `账号 ${account.id}`, ...db.dailyStats(account.id) })) }));
app.get('/api/accounts/:id/daily/config', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); const account = db.getAccount(id); if (!account) return reply.code(404).send({ error: '账号不存在' });
  const override = (db.getConfig(id) as any).daily_tasks || {}; const inherited = readDailyGlobal(); return { scope: 'account', accountId: id, effective: mergeDailyConfig(override, inherited), overrides: override, defaults: mergeDailyConfig({}, inherited), inherited: Object.keys(override).length === 0, riskConsents: db.listDailyRiskConsents('account', id) };
});
app.put('/api/accounts/:id/daily/config', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  try { const body = (request.body || {}) as Record<string, any>; const config = db.getConfig(id) as any; const inherited = readDailyGlobal(); const current = mergeDailyConfig(config.daily_tasks, inherited); const { normalized, diff } = dailyConfigDiff(body.daily_tasks || body || {}, inherited); const confirmed = Array.isArray(body.riskConfirmations) ? body.riskConfirmations.map(String) : []; const missing = missingDailyRiskConsents('account', id, current, normalized, confirmed); if (missing.length) return reply.code(409).send({ error: '启用这些动作前需要确认风险', requiresConfirmation: missing.map(action => ({ action, label: dailyActionLabels[action] || action })) }); saveDailyRiskConsents('account', id, confirmed); if (Object.keys(diff).length) config.daily_tasks = diff; else delete config.daily_tasks; db.setConfig(id, config); return { scope: 'account', accountId: id, effective: normalized, overrides: diff, defaults: mergeDailyConfig({}, inherited), inherited: Object.keys(diff).length === 0, riskConsents: db.listDailyRiskConsents('account', id) }; }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '每日任务配置无效' }); }
});
app.post('/api/accounts/:id/daily/config/reset', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); const config = db.getConfig(id) as any; delete config.daily_tasks; db.setConfig(id, config); return { ok: true, accountId: id, effective: mergeDailyConfig({}, readDailyGlobal()), inherited: true }; });
app.post('/api/accounts/:id/daily/preview', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); const account = db.getAccount(id); if (!account) return reply.code(404).send({ error: '账号不存在' }); const config = db.getConfig(id) as any; const actions = Array.isArray((request.body as any)?.actions) ? (request.body as any).actions.map(String) : []; return scheduler.daily.previewRemote(account, mergeDailyConfig(config.daily_tasks, readDailyGlobal()), actions); });
app.get('/api/runs/:id/daily', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getRun(id)) return reply.code(404).send({ error: '运行记录不存在' }); const items = db.listDailyActions(id); const attempts = db.listDailyActionAttempts(id); const summaries = items.filter((item: any) => !item.target_id); const count = (status?: string) => summaries.filter((item: any) => !status || item.status === status).length; return { runId: id, items, attempts, summary: { total: summaries.length, success: count('success'), completed: count('completed'), skipped: count('skipped'), failed: count('failed'), throttled: count('throttled') } }; });
app.post('/api/accounts/:id/live-sessions', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); const type = String((request.body as any)?.type || 'live_automation'); if (!['live_automation', 'streaming'].includes(type)) return reply.code(400).send({ error: '不支持的长任务类型' }); try { return scheduler.enqueue(id, type, (request.body as any)?.options || {}); } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); } });
app.get('/api/accounts/:id/live-sessions', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); return db.listLongTaskSessions(id); });
app.delete('/api/live-sessions/:id', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); return scheduler.longTasks.cancel(id) ? { ok: true } : reply.code(404).send({ error: '长任务不存在' }); });
app.get('/api/daily/media', { preHandler: auth }, async () => ({ ffmpeg: await ffmpegStatus(), items: db.listMediaAssets() }));
app.post('/api/daily/media', { preHandler: auth }, async (request, reply) => {
  const part = await (request as any).file(); if (!part) return reply.code(400).send({ error: '请选择媒体文件' });
  let storedName = ''; let path = '';
  try {
    storedName = safeMediaName(part.filename); path = join(mediaDirectory, storedName); await pipeline(part.file, createWriteStream(path)); const size = statSync(path).size;
    if (size > 2 * 1024 * 1024 * 1024) throw new Error('素材不能超过 2GB');
    const probe = await probeMedia(path); return db.createMediaAsset({ originalName: String(part.filename).slice(0, 255), storedName, mimeType: String(part.mimetype || '').slice(0, 120), sizeBytes: size, durationSeconds: probe.duration, probeStatus: probe.ok ? 'ready' : 'failed', probeError: probe.ok ? null : probe.error });
  } catch (error) { if (storedName) removeMediaFile(storedName); return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete('/api/daily/media/:id', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); const asset = db.getMediaAsset(id); if (!asset) return reply.code(404).send({ error: '素材不存在' }); const referenced = [mergeDailyConfig(readDailyGlobal()), ...db.listAccounts().map(account => mergeDailyConfig((db.getConfig(account.id) as any).daily_tasks, readDailyGlobal()))].some(config => config.streaming.mediaId === id); if (referenced) return reply.code(409).send({ error: '该素材仍被默认配置或账号配置使用' }); removeMediaFile(asset.stored_name); db.deleteMediaAsset(id); return { ok: true }; });
app.get('/api/schedules', { preHandler: auth }, async () => db.listSchedules());
app.get('/api/schedules/defaults', { preHandler: auth }, async () => accountSchedules.listDefaults());
app.put('/api/schedules/defaults', { preHandler: auth }, async (request, reply) => {
  try { return accountSchedules.saveDefaults((request.body as any)?.schedules || request.body || {}); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '默认定时任务无效' }); }
});
app.post('/api/schedules/defaults/apply-to-all', { preHandler: auth }, async () => ({ ok: true, accounts: accountSchedules.applyDefaultsToAll() }));
app.get('/api/accounts/:id/schedules', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); return accountSchedules.listAccount(id);
});
app.post('/api/accounts/:id/schedules/:type/reset', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); const type = String((request.params as any).type);
  if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  if (!scheduleJobTypes.includes(type as any)) return reply.code(400).send({ error: '不支持的定时任务类型' });
  return accountSchedules.reset(id, type as any);
});
app.put('/api/accounts/:id/schedules/:type', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); const type = String((request.params as any).type); const body = (request.body || {}) as { cron?: string; enabled?: boolean };
  if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  if (!scheduleJobTypes.includes(type as any)) return reply.code(400).send({ error: '不支持的定时任务类型' });
  const cron = String(body.cron || '').trim();
  try { nextScheduleRun(cron); return accountSchedules.save(id, type as any, cron, body.enabled !== false); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Cron 格式错误' }); }
});
app.delete('/api/schedules/:id', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getSchedule(id)) return reply.code(404).send({ error: '定时任务不存在' }); db.deleteSchedule(id); return { ok: true };
});
app.get('/api/runs', { preHandler: auth }, async () => db.listRuns());
app.get('/api/runs/:id', { preHandler: auth }, async (request, reply) => { const row = db.getRun(parseId((request.params as any).id)); return row || reply.code(404).send({ error: '运行记录不存在' }); });
app.get('/api/runs/:id/participations', { preHandler: auth }, async (request) => {
  const query = (request.query || {}) as any;
  return db.listRunParticipations(parseId((request.params as any).id), { page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 25, status: query.status || undefined, search: query.search || undefined });
});
app.get('/api/runs/:id/cleanup', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getRun(id)) return reply.code(404).send({ error: '运行记录不存在' }); return db.getRunCleanup(id);
});
app.get('/api/runs/:id/logs', { preHandler: auth }, async (request) => {
  const query = (request.query || {}) as any;
  return db.listLogs(parseId((request.params as any).id), { cursor: Number(query.cursor) || undefined, limit: Number(query.limit) || 200, level: query.level || undefined, search: query.search || undefined, errorsOnly: query.errorsOnly === '1' || query.errorsOnly === 'true' });
});
app.get('/api/logs/stream', { preHandler: auth }, async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  reply.raw.write(': connected\n\n');
  const cleanup = () => { clearInterval(heartbeat); scheduler.events.off('event', handler); };
  const write = (value: string) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) { cleanup(); return; }
    try { reply.raw.write(value); } catch { cleanup(); }
  };
  const handler = (event: object) => write(`data: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 25000);
  scheduler.events.on('event', handler);
  request.raw.on('close', cleanup);
});
app.get('/api/lotteries', { preHandler: auth }, async (request) => {
  const query = (request.query || {}) as any;
  return db.listLotteries({ page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 25, accountId: Number(query.accountId) || undefined, source: query.source || undefined, discoveryStatus: query.discoveryStatus || undefined, participationStatus: query.participationStatus || undefined, drawTimeSource: query.drawTimeSource || undefined, filterSource: query.filterSource || undefined, search: query.search || undefined, from: query.from || undefined, to: query.to || undefined });
});
app.get('/api/lotteries/:id/events', { preHandler: auth }, async (request) => db.listLotteryEvents(parseId((request.params as any).id)));
app.get('/api/lotteries/:id/participations', { preHandler: auth }, async (request) => {
  const query = (request.query || {}) as any;
  return db.listLotteryParticipations(parseId((request.params as any).id), { page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 25, status: query.status || undefined, search: query.search || undefined });
});
app.get('/api/participations/:id/attempts', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id);
  if (!db.getParticipation(id)) return reply.code(404).send({ error: '参与记录不存在' });
  return db.getParticipationAttempts(id);
});
app.get('/api/lotteries/backfill/status', { preHandler: auth }, async () => enricher.status());
app.post('/api/lotteries/backfill', { preHandler: auth }, async (request, reply) => { const result = await enricher.runBatch(true); return result.accepted ? result : reply.code(409).send({ error: 'reason' in result ? result.reason : '补全任务暂不可用', ...result }); });
app.get('/api/wins', { preHandler: auth }, async () => db.listWins());
app.patch('/api/wins/:id/read', { preHandler: auth }, async (request) => { db.markWinRead(parseId((request.params as any).id)); return { ok: true }; });
app.get('/api/stats/overview', { preHandler: auth }, async () => db.stats());
app.get('/api/config', { preHandler: auth }, async () => publicConfigPayload(readGlobalConfig(), {}, 'default'));
app.put('/api/config', { preHandler: auth }, async (request, reply) => {
  try { const { diff } = diffFromDefaults(request.body || {}); db.setSetting('global_config', JSON.stringify(diff)); return { ok: true, ...publicConfigPayload(diff, {}, 'default') }; }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '配置无效' }); }
});
app.post('/api/config/apply-to-all', { preHandler: auth }, async () => ({ ok: true, accounts: db.resetAllConfigs() }));
app.post('/api/config/import', { preHandler: auth }, async (request, reply) => {
  const body = request.body as { config?: object; accounts?: Array<{ cookie?: string; note?: string }> };
  if (!body || typeof body !== 'object') return reply.code(400).send({ error: '导入内容必须是 JSON 对象' });
  if (body.config) {
    try { db.setSetting('global_config', JSON.stringify(diffFromDefaults(body.config).diff)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '默认账号配置无效' }); }
  }
  let imported = 0;
  for (const account of body.accounts || []) {
    if (!account.cookie || !account.cookie.includes('DedeUserID=')) continue;
    const verified = await verifyBiliCookie(account.cookie);
    if (!verified.ok) continue;
    const row = db.createAccount({ cookie: encrypt(account.cookie), note: account.note, uid: verified.profile.uid, name: verified.profile.name, profile: verified.profile });
    accountSchedules.ensureAccount(row!.id);
    imported += 1;
  }
  return { ok: true, imported };
});
app.get('/api/accounts/:id/config', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); return publicConfigPayload(db.getConfig(id), readGlobalConfig(), 'account'); });
app.put('/api/accounts/:id/config', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  try {
    const existing = db.getConfig(id) as Record<string, unknown>; const { diff } = diffFromBase(request.body || {}, readGlobalConfig());
    if (existing.ai) diff.ai = existing.ai;
    db.setConfig(id, diff); return publicConfigPayload(diff, readGlobalConfig(), 'account');
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '配置无效' }); }
});
app.post('/api/accounts/:id/config/reset', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  const config = db.resetConfig(id); return publicConfigPayload(config, readGlobalConfig(), 'account');
});
app.get('/api/config/export', { preHandler: auth }, async () => ({ accounts: db.listAccounts().map(publicAccount), exportedAt: new Date().toISOString() }));
app.get('/api/ai/providers', { preHandler: auth }, async () => ai.listProviders());
app.get('/api/ai/config', { preHandler: auth }, async () => ai.getGlobalPublic());
app.put('/api/ai/config', { preHandler: auth }, async (request, reply) => {
  try { return ai.saveGlobal((request.body || {}) as Record<string, unknown>); } catch (error) { return reply.code(400).send({ error: String(error) }); }
});
app.post('/api/ai/test', { preHandler: auth }, async (request, reply) => {
  try { return await ai.test((request.body || {}) as Record<string, unknown>); } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'AI 请求失败' }); }
});
app.get('/api/accounts/:id/ai-config', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); return ai.getResolvedPublic(id);
});
app.put('/api/accounts/:id/ai-config', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  try { return ai.saveAccount(id, (request.body || {}) as Record<string, unknown>); } catch (error) { return reply.code(400).send({ error: String(error) }); }
});
app.post('/api/accounts/:id/ai-test', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  try { return await ai.test((request.body || {}) as Record<string, unknown>, id); } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'AI 请求失败' }); }
});
app.get('/api/notifications/email/config', { preHandler: auth }, async () => notifications.getPublic());
app.put('/api/notifications/email/config', { preHandler: auth }, async (request, reply) => {
  try { return notifications.save((request.body || {}) as Record<string, unknown>); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post('/api/notifications/email/test', { preHandler: auth }, async (request, reply) => {
  try { const result = await notifications.sendTest(); return result?.ok ? result : reply.code(502).send({ error: result?.error || '测试邮件发送失败' }); }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get('/api/accounts/:id/notifications/email', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  try { return notifications.getAccountNotification(id); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.put('/api/accounts/:id/notifications/email', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  try { return notifications.saveAccountNotification(id, (request.body || {}) as Record<string, unknown>); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post('/api/accounts/:id/notifications/email/test', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' });
  try { const result = await notifications.sendTest(id); return result?.ok ? result : reply.code(502).send({ error: result?.error || '测试邮件发送失败' }); }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get('/api/notifications', { preHandler: auth }, async () => db.listNotifications());
app.get('/api/update/status', { preHandler: auth }, async () => updater.status());
app.post('/api/update/package', { preHandler: auth, bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
  try {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: '发布包格式无效' });
    return updater.uploadPackage(request.body, (request.query as any)?.commit);
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post('/api/update/check', { preHandler: auth }, async (request, reply) => {
  try { return await updater.check(); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post('/api/update/apply', { preHandler: auth }, async (request, reply) => {
  try { return updater.apply(); } catch (error) { return reply.code(409).send({ error: String(error) }); }
});
app.get('/api/update/logs', { preHandler: auth }, async () => updater.logs());

const dist = join(process.cwd(), 'web', 'dist');
if (existsSync(dist)) { await app.register(fastifyStatic, { root: dist }); app.setNotFoundHandler((request, reply) => request.raw.url?.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html')); }

const port = Number(process.env.PORT || 6666);
app.addHook('onClose', async () => { accountSchedules.stop(); enricher.stop(); await scheduler.longTasks.shutdown(); });
await app.listen({ port, host: process.env.HOST || '0.0.0.0' });
console.log(`Lottery web console listening on http://localhost:${port}`);
void verifier.verifyAll('unknown').catch(error => console.error('自动验证账号失败', error instanceof Error ? error.message : String(error)));
enricher.start();
}

bootstrap().catch(error => { console.error(error); process.exitCode = 1; });
