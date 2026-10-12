import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppDatabase } from './db';
import { encrypt, verifyPassword } from './security';
import { createQrSession, pollQrSession, verifyBiliCookie } from './bili';
import { SerialScheduler } from './scheduler';
import { diffFromBase, diffFromDefaults, publicConfigPayload } from './config';
import { UpdateService } from './updater';
import { AiService } from './ai';
import { AccountScheduleService, nextScheduleRun, scheduleJobTypes } from './account-schedules';
import { EmailNotificationService } from './notifications';
import { AccountVerifier } from './account-verifier';
import { LotteryEnricher } from './lottery-enricher';

async function bootstrap() {
const app = Fastify({ logger: false });
const db = await AppDatabase.create();
function readGlobalConfig() { try { return JSON.parse(db.getSetting('global_config') || '{}') as Record<string, unknown>; } catch { return {}; } }
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

async function auth(request: any, reply: any) { if (!sessions.has(request.cookies.admin_session)) return reply.code(401).send({ error: '未登录' }); }
function publicAccount(account: any) { if (!account) return account; const { cookie: _cookie, ...safe } = account; return { ...safe, profile: safe.profile_json ? JSON.parse(safe.profile_json) : null }; }
function parseId(value: string) { const id = Number(value); if (!Number.isInteger(id) || id < 1) throw new Error('无效 ID'); return id; }

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

app.post('/api/accounts/:id/jobs', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); const type = (request.body as any)?.type || 'start'; if (!['start', 'discover', 'check', 'clear', 'account'].includes(type)) return reply.code(400).send({ error: '不支持的任务类型' }); return scheduler.enqueue(id, type); });
app.post('/api/jobs/:id/cancel', { preHandler: auth }, async (request) => ({ ok: scheduler.cancel(parseId((request.params as any).id)) }));
app.get('/api/jobs', { preHandler: auth }, async () => db.listJobs());
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
app.get('/api/notifications', { preHandler: auth }, async () => db.listNotifications());
app.get('/api/update/status', { preHandler: auth }, async () => updater.status());
app.post('/api/update/check', { preHandler: auth }, async (request, reply) => {
  try { return await updater.check(); } catch (error) { return reply.code(502).send({ error: String(error) }); }
});
app.post('/api/update/apply', { preHandler: auth }, async (request, reply) => {
  try { return updater.apply(); } catch (error) { return reply.code(409).send({ error: String(error) }); }
});
app.get('/api/update/logs', { preHandler: auth }, async () => updater.logs());

const dist = join(process.cwd(), 'web', 'dist');
if (existsSync(dist)) { await app.register(fastifyStatic, { root: dist }); app.setNotFoundHandler((request, reply) => request.raw.url?.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html')); }

const port = Number(process.env.PORT || 6666);
app.addHook('onClose', async () => { accountSchedules.stop(); enricher.stop(); });
await app.listen({ port, host: process.env.HOST || '0.0.0.0' });
console.log(`Lottery web console listening on http://localhost:${port}`);
void verifier.verifyAll('unknown').catch(error => console.error('自动验证账号失败', error instanceof Error ? error.message : String(error)));
enricher.start();
}

bootstrap().catch(error => { console.error(error); process.exitCode = 1; });
