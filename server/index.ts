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

async function bootstrap() {
const app = Fastify({ logger: false });
const db = await AppDatabase.create();
const scheduler = new SerialScheduler(db);
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
app.post('/api/accounts/:id/verify', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); const account = db.getAccount(id); if (!account) return reply.code(404).send({ error: '账号不存在' }); const verified = await verifyBiliCookie(decrypt(account.cookie)); if (!verified.ok) { db.updateAccount(id, { cookieStatus: 'invalid' }); return reply.code(400).send(verified); } db.updateAccountCookie(id, account.cookie, verified.profile); return { ok: true, profile: verified.profile }; });

app.post('/api/accounts/qr/start', { preHandler: auth }, async () => { const qr = await createQrSession(); const id = randomBytes(10).toString('hex'); qrSessions.set(id, { key: qr.key, expires: Date.now() + 180000 }); return { sessionId: id, image: qr.image, expiresAt: Date.now() + 180000 }; });
app.post('/api/accounts/qr/:sessionId/poll', { preHandler: auth }, async (request, reply) => { const session = qrSessions.get((request.params as any).sessionId); if (!session || session.expires < Date.now()) return reply.code(410).send({ status: 'expired' }); const result = await pollQrSession(session.key); if (result.status === 'success' && result.rawCookie) { const verified = await verifyBiliCookie(result.rawCookie); if (!verified.ok) return reply.code(400).send(verified); const row = db.createAccount({ cookie: encrypt(result.rawCookie), uid: verified.profile.uid, name: verified.profile.name, profile: verified.profile }); qrSessions.delete((request.params as any).sessionId); return { ...result, rawCookie: undefined, account: publicAccount(row) }; } return { ...result, rawCookie: undefined }; });

app.post('/api/accounts/:id/jobs', { preHandler: auth }, async (request, reply) => { const id = parseId((request.params as any).id); if (!db.getAccount(id)) return reply.code(404).send({ error: '账号不存在' }); const type = (request.body as any)?.type || 'start'; if (!['start', 'check', 'clear', 'account'].includes(type)) return reply.code(400).send({ error: '不支持的任务类型' }); return scheduler.enqueue(id, type); });
app.post('/api/jobs/:id/cancel', { preHandler: auth }, async (request) => ({ ok: scheduler.cancel(parseId((request.params as any).id)) }));
app.get('/api/jobs', { preHandler: auth }, async () => db.listJobs());
app.get('/api/runs', { preHandler: auth }, async () => db.listRuns());
app.get('/api/runs/:id/logs', { preHandler: auth }, async (request) => db.listLogs(parseId((request.params as any).id)));
app.get('/api/logs/stream', { preHandler: auth }, async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  reply.raw.write(': connected\n\n');
  const handler = (event: object) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 25000);
  scheduler.events.on('event', handler);
  request.raw.on('close', () => { clearInterval(heartbeat); scheduler.events.off('event', handler); });
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
await app.listen({ port, host: process.env.HOST || '0.0.0.0' });
console.log(`Lottery web console listening on http://localhost:${port}`);
}

bootstrap().catch(error => { console.error(error); process.exitCode = 1; });
