import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppDatabase } from './db';
import { decrypt, encrypt, redactCookie, verifyPassword } from './security';
import { createQrSession, pollQrSession, verifyBiliCookie } from './bili';
import { SerialScheduler } from './scheduler';
import { mergedConfig } from './config';
import { UpdateService } from './updater';
import { AiService } from './ai';
import { AccountScheduleService, nextScheduleRun, scheduleJobTypes } from './account-schedules';
import { EmailNotificationService } from './notifications';

async function bootstrap() {
const app = Fastify({ logger: false });
const db = await AppDatabase.create();
const ai = new AiService(db);
const notifications = new EmailNotificationService(db);
const scheduler = new SerialScheduler(db, ai, notifications);
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
  const verified = await verifyBiliCookie(body.cookie); if (!verified.ok) return reply.code(400).send({ error: verified.error });
  const row = db.createAccount({ cookie: encrypt(body.cookie), note: body.note, uid: verified.profile.uid, name: verified.profile.name, profile: verified.profile });
  return publicAccount(row);
});
app.patch('/api/accounts/:id', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); const row = db.updateAccount(id, request.body as any); if (!row) return reply.code(404).send({ error: '账号不存在' }); return publicAccount(row); });
app.delete('/api/accounts/:id', { preHandler: auth }, async (request) => { db.deleteAccount(parseId((request.params as any).id)); return { ok: true }; });
app.post('/api/accounts/:id/verify', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); const account = db.getAccount(id); if (!account) return reply.code(404).send({ error: '账号不存在' });
  const verified = await verifyBiliCookie(decrypt(account.cookie));
  if (!verified.ok) { db.updateAccount(id, { cookieStatus: 'invalid' }); void notifications.notifyInvalid(db.getAccount(id)!, verified.error || 'B站登录验证失败').catch(() => undefined); return reply.code(400).send(verified); }
  const wasInvalid = account.cookie_status === 'invalid'; const updated = db.updateAccountCookie(id, account.cookie, verified.profile)!;
  if (wasInvalid) void notifications.notifyRecovery(updated).catch(() => undefined);
  return { ok: true, profile: verified.profile };
});

app.post('/api/accounts/qr/start', { preHandler: auth }, async () => { const qr = await createQrSession(); const id = randomBytes(10).toString('hex'); qrSessions.set(id, { key: qr.key, expires: Date.now() + 180000 }); return { sessionId: id, image: qr.image, expiresAt: Date.now() + 180000 }; });
app.post('/api/accounts/qr/:sessionId/poll', { preHandler: auth }, async (request, reply) => { const session = qrSessions.get((request.params as any).sessionId); if (!session || session.expires < Date.now()) return reply.code(410).send({ status: 'expired' }); const result = await pollQrSession(session.key); if (result.status === 'success' && result.rawCookie) { const verified = await verifyBiliCookie(result.rawCookie); if (!verified.ok) return reply.code(400).send(verified); const row = db.createAccount({ cookie: encrypt(result.rawCookie), uid: verified.profile.uid, name: verified.profile.name, profile: verified.profile }); qrSessions.delete((request.params as any).sessionId); return { ...result, rawCookie: undefined, account: publicAccount(row) }; } return { ...result, rawCookie: undefined }; });

app.post('/api/accounts/:id/jobs', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); const type = (request.body as any)?.type || 'start'; if (!['start', 'discover', 'check', 'clear', 'account'].includes(type)) return reply.code(400).send({ error: '不支持的任务类型' }); return scheduler.enqueue(id, type); });
app.post('/api/jobs/:id/cancel', { preHandler: auth }, async (request) => ({ ok: scheduler.cancel(parseId((request.params as any).id)) }));
app.get('/api/jobs', { preHandler: auth }, async () => db.listJobs());
app.get('/api/schedules', { preHandler: auth }, async () => db.listSchedules());
app.get('/api/accounts/:id/schedules', { preHandler: auth }, async (request, reply) => {
  const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); return db.listSchedules(id);
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
app.get('/api/runs/:id/logs', { preHandler: auth }, async (request) => db.listLogs(parseId((request.params as any).id)));
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
app.get('/api/lotteries', { preHandler: auth }, async () => db.listLotteries());
app.get('/api/wins', { preHandler: auth }, async () => db.listWins());
app.patch('/api/wins/:id/read', { preHandler: auth }, async (request) => { db.markWinRead(parseId((request.params as any).id)); return { ok: true }; });
app.get('/api/stats/overview', { preHandler: auth }, async () => db.stats());
app.get('/api/config', { preHandler: auth }, async () => ({ defaultConfig: mergedConfig({}), keys: Object.keys(mergedConfig({})) }));
app.put('/api/config', { preHandler: auth }, async (request) => { db.setSetting('global_config', JSON.stringify(request.body || {})); return { ok: true }; });
app.post('/api/config/import', { preHandler: auth }, async (request, reply) => {
  const body = request.body as { config?: object; accounts?: Array<{ cookie?: string; note?: string }> };
  if (!body || typeof body !== 'object') return reply.code(400).send({ error: '导入内容必须是 JSON 对象' });
  if (body.config) db.setSetting('global_config', JSON.stringify(body.config));
  let imported = 0;
  for (const account of body.accounts || []) {
    if (!account.cookie || !account.cookie.includes('DedeUserID=')) continue;
    const verified = await verifyBiliCookie(account.cookie);
    if (!verified.ok) continue;
    db.createAccount({ cookie: encrypt(account.cookie), note: account.note, uid: verified.profile.uid, name: verified.profile.name, profile: verified.profile });
    imported += 1;
  }
  return { ok: true, imported };
});
app.get('/api/accounts/:id/config', { preHandler: auth }, async (request) => mergedConfig(db.getConfig(parseId((request.params as any).id))));
app.put('/api/accounts/:id/config', { preHandler: auth }, async (request) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return { error: '账号不存在' }; db.setConfig(id, request.body as Record<string, unknown>); return mergedConfig(request.body as Record<string, unknown>); });
app.get('/api/config/export', { preHandler: auth }, async () => ({ accounts: db.listAccounts().map(publicAccount), exportedAt: new Date().toISOString() }));
app.get('/api/ai/providers', { preHandler: auth }, async () => ai.listProviders());
app.get('/api/ai/config', { preHandler: auth }, async () => ai.getGlobalPublic());
app.put('/api/ai/config', { preHandler: auth }, async (request, reply) => {
  try { return ai.saveGlobal((request.body || {}) as Record<string, unknown>); } catch (error) { return reply.code(400).send({ error: String(error) }); }
});
app.post('/api/ai/test', { preHandler: auth }, async (request, reply) => {
  try { return await ai.test((request.body || {}) as Record<string, unknown>); } catch (error) { return reply.code(502).send({ error: String(error) }); }
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
  try { return await ai.test((request.body || {}) as Record<string, unknown>, id); } catch (error) { return reply.code(502).send({ error: String(error) }); }
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
app.addHook('onClose', async () => accountSchedules.stop());
await app.listen({ port, host: process.env.HOST || '0.0.0.0' });
console.log(`Lottery web console listening on http://localhost:${port}`);
}

bootstrap().catch(error => { console.error(error); process.exitCode = 1; });
