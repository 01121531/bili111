import initSqlJs, { Database as SqlDatabase } from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashPassword } from './security';

export type AccountRow = { id: number; uid: string | null; name: string | null; note: string; cookie: string; cookie_status: string; enabled: number; profile_json: string | null; last_verified_at: string | null; verification_error: string | null; created_at: string; updated_at: string };
export type JobRow = { id: number; account_id: number; type: string; status: string; requested_at: string; started_at: string | null; finished_at: string | null; error: string | null };
export type ScheduleRow = { id: number; account_id: number; type: string; cron: string; enabled: number; is_override: number; last_run_at: string | null; next_run_at: string | null; last_job_id: number | null; created_at: string; updated_at: string };
export type ScheduleSeed = { accountId: number; type: string; cron: string; enabled: boolean; nextRunAt: string | null; isOverride: boolean };
export type NotificationRow = { id: number; account_id: number | null; run_id: number | null; channel: string; event_type: string; title: string; content: string; status: string; error: string | null; attempts: number; last_attempt_at: string | null; created_at: string };
export type LotteryInput = { dyid: string; source?: string; author?: string; description?: string; drawTime?: number | null; drawTimeSource?: string | null; official?: boolean; status?: string; resultReason?: string; url?: string; sourceCreatedAt?: number | null; enrichmentStatus?: string; runId?: number };
export type ParticipationAction = { plannedText?: string | null; actualText?: string | null; source?: string; status?: string; code?: number; reason?: string };
export type ParticipationInput = { dyid: string; overallStatus: string; resultCode?: number; resultReason?: string; comment?: ParticipationAction; follow?: ParticipationAction; like?: ParticipationAction; relay?: ParticipationAction; startedAt?: string; finishedAt?: string };
export type LotteryQuery = { page?: number; pageSize?: number; accountId?: number; source?: string; discoveryStatus?: string; participationStatus?: string; drawTimeSource?: string; filterSource?: string; search?: string; from?: string; to?: string };
export type ParticipationQuery = { page?: number; pageSize?: number; status?: string; search?: string };
export type LogQuery = { cursor?: number; limit?: number; level?: string; search?: string; errorsOnly?: boolean };

export class AppDatabase {
  private constructor(private db: SqlDatabase, private filename: string) {}
  static async create(filename = process.env.DATABASE_PATH || join(process.cwd(), 'data', 'lottery.db')) {
    mkdirSync(dirname(filename), { recursive: true });
    const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
    const db = existsSync(filename) ? new SQL.Database(new Uint8Array(readFileSync(filename))) : new SQL.Database();
    const app = new AppDatabase(db, filename); app.migrate(); return app;
  }
  private flush() { writeFileSync(this.filename, Buffer.from(this.db.export())); }
  private rows<T = any>(sql: string, params: any[] = []) { const statement = this.db.prepare(sql); statement.bind(params); const result: T[] = []; while (statement.step()) result.push(statement.getAsObject() as T); statement.free(); return result; }
  private row<T = any>(sql: string, params: any[] = []) { return this.rows<T>(sql, params)[0] as T | undefined; }
  private run(sql: string, params: any[] = []) { const statement = this.db.prepare(sql); statement.bind(params); statement.step(); statement.free(); this.flush(); }
  private insert(sql: string, params: any[] = []) {
    const statement = this.db.prepare(sql);
    statement.bind(params);
    statement.step();
    statement.free();
    const id = Number(this.row<{ id: number }>('SELECT last_insert_rowid() id')!.id);
    this.flush();
    return id;
  }
  private hasColumn(table: string, column: string) { return this.rows<{ name: string }>(`PRAGMA table_info(${table})`).some(item => item.name === column); }
  private addColumn(table: string, definition: string) { const column = definition.split(/\s+/)[0]; if (!this.hasColumn(table, column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`); }
  private migrate() {
    this.db.run(`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE, name TEXT, note TEXT NOT NULL DEFAULT '', cookie TEXT NOT NULL, cookie_status TEXT NOT NULL DEFAULT 'unknown', enabled INTEGER NOT NULL DEFAULT 1, profile_json TEXT, last_verified_at TEXT, verification_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_configs (account_id INTEGER PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', requested_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, account_id INTEGER NOT NULL, status TEXT NOT NULL, discovered_count INTEGER NOT NULL DEFAULT 0, attempted_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, account_id INTEGER NOT NULL, level TEXT NOT NULL, context TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lotteries (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, dyid TEXT NOT NULL, source TEXT, author TEXT, description TEXT, draw_time INTEGER, draw_time_source TEXT, official INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'discovered', result_reason TEXT, url TEXT, source_created_at INTEGER, enrichment_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT, UNIQUE(account_id,dyid));
      CREATE TABLE IF NOT EXISTS lottery_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, run_id INTEGER, lottery_id INTEGER NOT NULL, dyid TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participation_records (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, account_id INTEGER NOT NULL, lottery_id INTEGER NOT NULL, dyid TEXT NOT NULL, overall_status TEXT NOT NULL, result_code INTEGER NOT NULL DEFAULT 0, result_reason TEXT, comment_planned_text TEXT, comment_text TEXT, comment_source TEXT, comment_status TEXT NOT NULL DEFAULT 'not_required', comment_code INTEGER NOT NULL DEFAULT 0, comment_reason TEXT, follow_status TEXT NOT NULL DEFAULT 'not_required', follow_code INTEGER NOT NULL DEFAULT 0, follow_reason TEXT, like_status TEXT NOT NULL DEFAULT 'not_required', like_code INTEGER NOT NULL DEFAULT 0, like_reason TEXT, relay_planned_text TEXT, relay_text TEXT, relay_source TEXT, relay_status TEXT NOT NULL DEFAULT 'not_required', relay_code INTEGER NOT NULL DEFAULT 0, relay_reason TEXT, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, UNIQUE(run_id,lottery_id));
      CREATE TABLE IF NOT EXISTS win_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, source TEXT NOT NULL, actor TEXT, content TEXT NOT NULL, url TEXT, occurred_at TEXT, event_key TEXT, matched INTEGER NOT NULL DEFAULT 1, is_read INTEGER NOT NULL DEFAULT 0, detected_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, run_id INTEGER, channel TEXT NOT NULL, event_type TEXT NOT NULL DEFAULT '', title TEXT, content TEXT, status TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, type TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, last_run_at TEXT, next_run_at TEXT, last_job_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(account_id,type));
      CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.addColumn('win_events', 'actor TEXT');
    this.addColumn('win_events', 'occurred_at TEXT');
    this.addColumn('win_events', 'event_key TEXT');
    this.addColumn('notifications', 'run_id INTEGER');
    this.addColumn('notifications', "event_type TEXT NOT NULL DEFAULT ''");
    this.addColumn('notifications', 'attempts INTEGER NOT NULL DEFAULT 0');
    this.addColumn('notifications', 'last_attempt_at TEXT');
    this.addColumn('accounts', 'last_verified_at TEXT');
    this.addColumn('accounts', 'verification_error TEXT');
    this.addColumn('lotteries', 'result_reason TEXT');
    this.addColumn('lotteries', 'source_created_at INTEGER');
    this.addColumn('lotteries', 'draw_time_source TEXT');
    this.addColumn('lotteries', "enrichment_status TEXT NOT NULL DEFAULT 'pending'");
    this.addColumn('lotteries', 'updated_at TEXT');
    this.addColumn('lotteries', "discovery_status TEXT NOT NULL DEFAULT 'pending'");
    this.addColumn('lotteries', "participation_status TEXT NOT NULL DEFAULT 'not_attempted'");
    this.addColumn('lotteries', 'filter_reason TEXT');
    this.addColumn('lotteries', 'participation_result TEXT');
    this.addColumn('lotteries', 'participated_at TEXT');
    this.addColumn('lotteries', 'last_run_id INTEGER');
    this.addColumn('runs', 'candidate_count INTEGER NOT NULL DEFAULT 0');
    this.addColumn('runs', 'participated_count INTEGER NOT NULL DEFAULT 0');
    this.addColumn('runs', 'partial_count INTEGER NOT NULL DEFAULT 0');
    this.addColumn('runs', 'failed_count INTEGER NOT NULL DEFAULT 0');
    this.addColumn('account_schedules', 'is_override INTEGER NOT NULL DEFAULT 1');
    this.db.run("UPDATE lotteries SET source='legacy' WHERE source IN ('start','discover')");
    this.db.run("UPDATE lotteries SET discovery_status=CASE WHEN status='candidate' THEN 'candidate' WHEN status='filtered' THEN 'filtered' WHEN status IN ('participated','failed') THEN 'candidate' ELSE 'pending' END WHERE discovery_status='pending'");
    this.db.run("UPDATE lotteries SET participation_status='participated',participated_at=COALESCE(participated_at,updated_at,created_at),participation_result=COALESCE(participation_result,result_reason) WHERE status='participated' AND participation_status='not_attempted'");
    this.db.run("UPDATE lotteries SET participation_status='failed',participation_result=COALESCE(participation_result,result_reason) WHERE status='failed' AND participation_status='not_attempted'");
    this.db.run("UPDATE lotteries SET discovery_status='candidate',participation_status='already_participated',participation_result=COALESCE(participation_result,result_reason) WHERE result_reason='已参与或已转发' AND participation_status='not_attempted'");
    this.db.run("UPDATE lotteries SET filter_reason=COALESCE(filter_reason,result_reason) WHERE discovery_status='filtered'");
    this.db.run('CREATE INDEX IF NOT EXISTS idx_lottery_events_lottery ON lottery_events(lottery_id,id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_lotteries_status ON lotteries(discovery_status,participation_status,id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_participation_records_run ON participation_records(run_id,id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_participation_records_lottery ON participation_records(lottery_id,id)');
    this.db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_win_events_event_key ON win_events(event_key) WHERE event_key IS NOT NULL');
    this.flush(); if (!this.getSetting('admin_password_hash')) this.setSetting('admin_password_hash', hashPassword(process.env.ADMIN_PASSWORD || 'admin'));
  }
  now() { return new Date().toISOString(); }
  getSetting(key: string) { return this.row<{ value: string }>('SELECT value FROM system_settings WHERE key=?', [key])?.value; }
  setSetting(key: string, value: string) { this.run('INSERT INTO system_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]); }
  listAccounts() { return this.rows<Omit<AccountRow, 'cookie'>>('SELECT id,uid,name,note,cookie_status,enabled,profile_json,last_verified_at,verification_error,created_at,updated_at FROM accounts ORDER BY id DESC'); }
  getAccount(id: number) { return this.row<AccountRow>('SELECT * FROM accounts WHERE id=?', [id]); }
  findAccountByUid(uid: string) { return this.row<AccountRow>('SELECT * FROM accounts WHERE uid=?', [uid]); }
  listAccountsByStatus(status: string) { return this.rows<AccountRow>('SELECT * FROM accounts WHERE cookie_status=? ORDER BY id', [status]); }
  createAccount(input: { uid?: string | null; name?: string | null; note?: string; cookie: string; profile?: object | null }) {
    const now = this.now(); const existing = input.uid ? this.findAccountByUid(input.uid) : undefined;
    if (existing) {
      this.run('UPDATE accounts SET cookie=?,name=?,note=?,cookie_status=?,profile_json=?,last_verified_at=?,verification_error=NULL,updated_at=? WHERE id=?', [input.cookie, input.name || existing.name, input.note === undefined || input.note === '' ? existing.note : input.note, 'valid', input.profile ? JSON.stringify(input.profile) : existing.profile_json, now, now, existing.id]);
      return this.getAccount(existing.id);
    }
    const id = this.insert('INSERT INTO accounts(uid,name,note,cookie,cookie_status,profile_json,last_verified_at,verification_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [input.uid || null, input.name || null, input.note || '', input.cookie, 'valid', input.profile ? JSON.stringify(input.profile) : null, now, null, now, now]);
    this.run('INSERT INTO account_configs(account_id,config_json,updated_at) VALUES (?,?,?)', [id, '{}', now]); return this.getAccount(id);
  }
  updateAccount(id: number, patch: { note?: string; enabled?: boolean; name?: string; cookieStatus?: string; profile?: object; verificationError?: string | null; verifiedAt?: string | null }) { const current = this.getAccount(id); if (!current) return undefined; this.run('UPDATE accounts SET note=?,enabled=?,name=?,cookie_status=?,profile_json=?,last_verified_at=?,verification_error=?,updated_at=? WHERE id=?', [patch.note ?? current.note, patch.enabled === undefined ? current.enabled : (patch.enabled ? 1 : 0), patch.name ?? current.name, patch.cookieStatus ?? current.cookie_status, patch.profile ? JSON.stringify(patch.profile) : current.profile_json, patch.verifiedAt === undefined ? current.last_verified_at : patch.verifiedAt, patch.verificationError === undefined ? current.verification_error : patch.verificationError, this.now(), id]); return this.getAccount(id); }
  updateAccountCookie(id: number, cookie: string, profile?: { uid?: string; name?: string }) { const now = this.now(); this.run('UPDATE accounts SET cookie=?,uid=COALESCE(?,uid),name=COALESCE(?,name),cookie_status=?,profile_json=COALESCE(?,profile_json),last_verified_at=?,verification_error=NULL,updated_at=? WHERE id=?', [cookie, profile?.uid || null, profile?.name || null, 'valid', profile ? JSON.stringify(profile) : null, now, now, id]); return this.getAccount(id); }
  deleteAccount(id: number) { this.run('DELETE FROM account_schedules WHERE account_id=?', [id]); this.run('DELETE FROM accounts WHERE id=?', [id]); }
  getConfig(id: number) { const row = this.row<{ config_json: string }>('SELECT config_json FROM account_configs WHERE account_id=?', [id]); return row ? JSON.parse(row.config_json) : {}; }
  setConfig(id: number, config: object) { this.run('INSERT INTO account_configs(account_id,config_json,updated_at) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at', [id, JSON.stringify(config), this.now()]); }
  resetConfig(id: number) {
    const current = this.getConfig(id) as Record<string, unknown>;
    this.setConfig(id, current.ai ? { ai: current.ai } : {});
    return this.getConfig(id);
  }
  resetAllConfigs() {
    const rows = this.rows<{ account_id: number; config_json: string }>('SELECT account_id,config_json FROM account_configs');
    this.db.run('BEGIN');
    try {
      for (const row of rows) {
        let current: Record<string, unknown> = {};
        try { current = JSON.parse(row.config_json); } catch { current = {}; }
        const next = current.ai ? { ai: current.ai } : {};
        this.db.run('UPDATE account_configs SET config_json=?,updated_at=? WHERE account_id=?', [JSON.stringify(next), this.now(), row.account_id]);
      }
      this.db.run('COMMIT'); this.flush();
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    return rows.length;
  }
  createJob(accountId: number, type: string) { const id = this.insert('INSERT INTO jobs(account_id,type,requested_at) VALUES (?,?,?)', [accountId, type, this.now()]); return this.getJob(id)!; }
  listJobs(limit = 50) { return this.rows('SELECT j.*,a.name account_name,a.uid FROM jobs j JOIN accounts a ON a.id=j.account_id ORDER BY j.id DESC LIMIT ?', [limit]); }
  getJob(id: number) { return this.row<JobRow>('SELECT * FROM jobs WHERE id=?', [id]); }
  updateJob(id: number, status: string, fields: { startedAt?: string; finishedAt?: string; error?: string } = {}) { this.run('UPDATE jobs SET status=?,started_at=COALESCE(?,started_at),finished_at=COALESCE(?,finished_at),error=COALESCE(?,error) WHERE id=?', [status, fields.startedAt || null, fields.finishedAt || null, fields.error || null, id]); return this.getJob(id); }
  recoverInterruptedJobs() {
    const now = this.now();
    this.run("UPDATE jobs SET status='failed',finished_at=?,error=COALESCE(error,'服务重启，任务已中断') WHERE status IN ('pending','running')", [now]);
    this.run("UPDATE runs SET status='failed',finished_at=?,error=COALESCE(error,'服务重启，运行已中断') WHERE status='running'", [now]);
  }
  createRun(jobId: number, accountId: number) { return this.insert('INSERT INTO runs(job_id,account_id,status,started_at) VALUES (?,?,?,?)', [jobId, accountId, 'running', this.now()]); }
  finishRun(id: number, status: string, stats: Record<string, number | string> = {}) { this.run('UPDATE runs SET status=?,discovered_count=?,candidate_count=?,attempted_count=?,success_count=?,participated_count=?,partial_count=?,failed_count=?,error_count=?,finished_at=?,error=? WHERE id=?', [status, stats.discovered_count || 0, stats.candidate_count || 0, stats.attempted_count || 0, stats.success_count || 0, stats.participated_count || stats.success_count || 0, stats.partial_count || 0, stats.failed_count || 0, stats.error_count || 0, this.now(), stats.error || null, id]); }
  listRuns(limit = 50) { return this.rows('SELECT r.*,a.name account_name,a.uid,j.type FROM runs r JOIN accounts a ON a.id=r.account_id JOIN jobs j ON j.id=r.job_id ORDER BY r.id DESC LIMIT ?', [limit]); }
  getRun(id: number) { return this.row('SELECT r.*,a.name account_name,a.uid,j.type,j.requested_at FROM runs r JOIN accounts a ON a.id=r.account_id JOIN jobs j ON j.id=r.job_id WHERE r.id=?', [id]); }
  addLog(runId: number, accountId: number, level: string, context: string, message: string) { const createdAt = this.now(); const id = this.insert('INSERT INTO logs(run_id,account_id,level,context,message,created_at) VALUES (?,?,?,?,?,?)', [runId, accountId, level, context, message, createdAt]); return { id, run_id: runId, account_id: accountId, level, context, message, created_at: createdAt }; }
  listLogs(runId: number, query: number | LogQuery = 500) {
    if (typeof query === 'number') return this.rows('SELECT * FROM logs WHERE run_id=? ORDER BY id ASC LIMIT ?', [runId, query]);
    const limit = Math.min(500, Math.max(20, Number(query.limit) || 200)); const where = ['run_id=?']; const params: any[] = [runId];
    if (query.cursor) { where.push('id>?'); params.push(query.cursor); }
    if (query.level) { where.push('level=?'); params.push(query.level); }
    if (query.errorsOnly) where.push("(level='error' OR message LIKE '%[Error]%' OR message LIKE '%错误%')");
    if (query.search) { where.push('(message LIKE ? OR context LIKE ?)'); params.push(`%${query.search}%`, `%${query.search}%`); }
    const items = this.rows<any>(`SELECT * FROM logs WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`, [...params, limit + 1]);
    const hasMore = items.length > limit; if (hasMore) items.pop();
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id || null : null, hasMore };
  }
  addLottery(accountId: number, dyid: string, source = 'runtime', url = `https://t.bilibili.com/${dyid}`) { return this.upsertLottery(accountId, { dyid, source, url }); }
  upsertLottery(accountId: number, input: LotteryInput) {
    const now = this.now(); const current = this.row<any>('SELECT * FROM lotteries WHERE account_id=? AND dyid=?', [accountId, input.dyid]);
    const incomingStatus = input.status || '';
    let discoveryStatus = current?.discovery_status || 'pending'; let participationStatus = current?.participation_status || 'not_attempted';
    let filterReason = current?.filter_reason || null; let participationResult = current?.participation_result || null; let participatedAt = current?.participated_at || null;
    if (incomingStatus === 'discovered') discoveryStatus = 'pending';
    if (incomingStatus === 'candidate') { discoveryStatus = 'candidate'; filterReason = null; }
    if (incomingStatus === 'filtered') {
      if (['已参与或已转发', '当前账号已参与或已转发'].includes(input.resultReason || '')) { discoveryStatus = 'candidate'; if (participationStatus !== 'participated') participationStatus = 'already_participated'; participationResult = input.resultReason; }
      else { discoveryStatus = 'filtered'; filterReason = input.resultReason || null; }
    }
    if (incomingStatus === 'participated') { discoveryStatus = 'candidate'; participationStatus = 'participated'; participationResult = input.resultReason || '参与操作完成'; participatedAt = now; }
    if (incomingStatus === 'partial' && participationStatus !== 'participated') { discoveryStatus = 'candidate'; participationStatus = 'partial'; participationResult = input.resultReason || '部分参与操作完成'; participatedAt = now; }
    if (incomingStatus === 'failed' && participationStatus !== 'participated') { discoveryStatus = 'candidate'; participationStatus = 'failed'; participationResult = input.resultReason || '参与失败'; }
    const legacyStatus = participationStatus === 'participated' ? 'participated' : ['partial', 'failed'].includes(participationStatus) ? 'failed' : discoveryStatus === 'filtered' ? 'filtered' : discoveryStatus === 'candidate' ? 'candidate' : 'discovered';
    if (!current) {
      this.run('INSERT INTO lotteries(account_id,dyid,source,author,description,draw_time,draw_time_source,official,status,result_reason,url,source_created_at,enrichment_status,created_at,updated_at,discovery_status,participation_status,filter_reason,participation_result,participated_at,last_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [accountId, input.dyid, input.source || 'runtime', input.author || null, input.description || null, input.drawTime && input.drawTime > 0 ? input.drawTime : null, input.drawTimeSource || null, input.official ? 1 : 0, legacyStatus, input.resultReason || null, input.url || `https://t.bilibili.com/${input.dyid}`, input.sourceCreatedAt || null, input.enrichmentStatus || (input.description ? 'complete' : 'pending'), now, now, discoveryStatus, participationStatus, filterReason, participationResult, participatedAt, input.runId || null]);
    } else {
      this.run('UPDATE lotteries SET source=?,author=?,description=?,draw_time=?,draw_time_source=?,official=?,status=?,result_reason=?,url=?,source_created_at=?,enrichment_status=?,updated_at=?,discovery_status=?,participation_status=?,filter_reason=?,participation_result=?,participated_at=?,last_run_id=? WHERE id=?', [input.source || current.source, input.author || current.author, input.description || current.description, input.drawTime && input.drawTime > 0 ? input.drawTime : current.draw_time, input.drawTimeSource === undefined ? current.draw_time_source : input.drawTimeSource, input.official === undefined ? current.official : (input.official ? 1 : 0), legacyStatus, input.resultReason === undefined ? current.result_reason : input.resultReason, input.url || current.url, input.sourceCreatedAt || current.source_created_at, input.enrichmentStatus || (input.description ? 'complete' : current.enrichment_status), now, discoveryStatus, participationStatus, filterReason, participationResult, participatedAt, input.runId || current.last_run_id, current.id]);
    }
    const row = this.row<any>('SELECT * FROM lotteries WHERE account_id=? AND dyid=?', [accountId, input.dyid]);
    if (input.runId && incomingStatus && row) {
      const wasAlreadyParticipated = ['已参与或已转发', '当前账号已参与或已转发'].includes(input.resultReason || '');
      const stage = ['participated', 'partial', 'failed'].includes(incomingStatus) || wasAlreadyParticipated ? 'participation' : 'discovery';
      const eventStatus = wasAlreadyParticipated ? participationStatus : ['participated', 'partial', 'failed'].includes(incomingStatus) ? incomingStatus : discoveryStatus;
      this.run('INSERT INTO lottery_events(account_id,run_id,lottery_id,dyid,stage,status,reason,created_at) VALUES (?,?,?,?,?,?,?,?)', [accountId, input.runId, row.id, input.dyid, stage, eventStatus, input.resultReason || null, now]);
    }
    return row;
  }
  listLotteries(query: number | LotteryQuery = 100) {
    if (typeof query === 'number') return this.rows('SELECT l.*,a.name account_name FROM lotteries l JOIN accounts a ON a.id=l.account_id ORDER BY l.id DESC LIMIT ?', [query]);
    const page = Math.max(1, Number(query.page) || 1); const pageSize = Math.min(100, Math.max(10, Number(query.pageSize) || 25));
    const where: string[] = []; const params: any[] = [];
    if (query.accountId) { where.push('l.account_id=?'); params.push(query.accountId); }
    if (query.source) { where.push('l.source=?'); params.push(query.source); }
    if (query.discoveryStatus) { where.push('l.discovery_status=?'); params.push(query.discoveryStatus); }
    if (query.participationStatus) {
      const allowed = new Set(['not_attempted', 'participated', 'already_participated', 'partial', 'failed']);
      const statuses = String(query.participationStatus).split(',').map(item => item.trim()).filter(item => allowed.has(item));
      if (statuses.length === 1) { where.push('l.participation_status=?'); params.push(statuses[0]); }
      else if (statuses.length > 1) { where.push(`l.participation_status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
    }
    if (query.drawTimeSource) { where.push('l.draw_time_source=?'); params.push(query.drawTimeSource); }
    if (query.filterSource === 'body') { where.push("l.filter_reason LIKE '正文命中屏蔽词：%'"); }
    if (query.filterSource === 'reserve') { where.push("l.filter_reason LIKE '预约文本命中屏蔽词：%'"); }
    if (query.filterSource === 'both') { where.push("l.filter_reason LIKE '%正文命中屏蔽词：%' AND l.filter_reason LIKE '%预约文本命中屏蔽词：%'"); }
    if (query.from) { where.push('l.created_at>=?'); params.push(query.from); }
    if (query.to) { where.push('l.created_at<=?'); params.push(query.to); }
    if (query.search) { where.push('(l.dyid LIKE ? OR l.author LIKE ? OR l.description LIKE ? OR l.result_reason LIKE ?)'); const term = `%${query.search}%`; params.push(term, term, term, term); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.row<any>(`SELECT COUNT(*) count FROM lotteries l ${clause}`, params)?.count || 0);
    const items = this.rows(`SELECT l.*,a.name account_name,
      (SELECT COUNT(DISTINCT p.account_id) FROM participation_records p WHERE p.dyid=l.dyid) participation_account_count
      FROM lotteries l JOIN accounts a ON a.id=l.account_id ${clause} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    const countAll = (condition: string) => Number(this.row<any>(`SELECT COUNT(*) count FROM lotteries l WHERE ${condition}`)?.count || 0);
    const participatedConfirmed = countAll("l.participation_status='participated'");
    const participatedBefore = countAll("l.participation_status='already_participated'");
    return { items, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), stats: { candidate: countAll("l.discovery_status='candidate'"), participated: participatedConfirmed + participatedBefore, participatedConfirmed, participatedBefore, partial: countAll("l.participation_status='partial'"), filtered: countAll("l.discovery_status='filtered'"), failed: countAll("l.participation_status='failed'") } };
  }
  listLotteryEvents(lotteryId: number) {
    const lottery = this.row<any>('SELECT dyid FROM lotteries WHERE id=?', [lotteryId]);
    if (!lottery) return [];
    return this.rows('SELECT e.*,r.status run_status,j.type run_type,a.name account_name FROM lottery_events e LEFT JOIN runs r ON r.id=e.run_id LEFT JOIN jobs j ON j.id=r.job_id LEFT JOIN accounts a ON a.id=e.account_id WHERE e.dyid=? ORDER BY e.id DESC LIMIT 100', [lottery.dyid]);
  }
  upsertParticipation(accountId: number, runId: number, input: ParticipationInput) {
    const lottery = this.row<any>('SELECT * FROM lotteries WHERE account_id=? AND dyid=?', [accountId, input.dyid]) || this.upsertLottery(accountId, { dyid: input.dyid });
    if (!lottery) throw new Error(`抽奖记录不存在：${input.dyid}`);
    const allowedOverall = new Set(['success', 'partial', 'failed']);
    const allowedAction = new Set(['not_required', 'not_attempted', 'success', 'failed']);
    const action = (value?: ParticipationAction) => ({
      plannedText: value?.plannedText ?? null,
      actualText: value?.actualText ?? null,
      source: value?.source || 'none',
      status: allowedAction.has(value?.status || '') ? value!.status! : 'not_required',
      code: Number(value?.code) || 0,
      reason: value?.reason || null
    });
    const comment = action(input.comment); const follow = action(input.follow); const like = action(input.like); const relay = action(input.relay);
    const overallStatus = allowedOverall.has(input.overallStatus) ? input.overallStatus : 'failed';
    const now = this.now(); const startedAt = input.startedAt || now; const finishedAt = input.finishedAt || now;
    this.run(`INSERT INTO participation_records(run_id,account_id,lottery_id,dyid,overall_status,result_code,result_reason,comment_planned_text,comment_text,comment_source,comment_status,comment_code,comment_reason,follow_status,follow_code,follow_reason,like_status,like_code,like_reason,relay_planned_text,relay_text,relay_source,relay_status,relay_code,relay_reason,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,lottery_id) DO UPDATE SET overall_status=excluded.overall_status,result_code=excluded.result_code,result_reason=excluded.result_reason,comment_planned_text=excluded.comment_planned_text,comment_text=excluded.comment_text,comment_source=excluded.comment_source,comment_status=excluded.comment_status,comment_code=excluded.comment_code,comment_reason=excluded.comment_reason,follow_status=excluded.follow_status,follow_code=excluded.follow_code,follow_reason=excluded.follow_reason,like_status=excluded.like_status,like_code=excluded.like_code,like_reason=excluded.like_reason,relay_planned_text=excluded.relay_planned_text,relay_text=excluded.relay_text,relay_source=excluded.relay_source,relay_status=excluded.relay_status,relay_code=excluded.relay_code,relay_reason=excluded.relay_reason,started_at=excluded.started_at,finished_at=excluded.finished_at`,
      [runId, accountId, lottery.id, input.dyid, overallStatus, Number(input.resultCode) || 0, input.resultReason || null, comment.plannedText, comment.actualText, comment.source, comment.status, comment.code, comment.reason, follow.status, follow.code, follow.reason, like.status, like.code, like.reason, relay.plannedText, relay.actualText, relay.source, relay.status, relay.code, relay.reason, startedAt, finishedAt]);
    return this.row<any>('SELECT * FROM participation_records WHERE run_id=? AND lottery_id=?', [runId, lottery.id]);
  }
  private listParticipationRecords(scope: 'run' | 'lottery', id: number, query: ParticipationQuery = {}) {
    const page = Math.max(1, Number(query.page) || 1); const pageSize = Math.min(100, Math.max(10, Number(query.pageSize) || 25));
    const scopeColumn = scope === 'run' ? 'p.run_id' : 'p.lottery_id'; const where: string[] = []; const params: any[] = [];
    if (scope === 'run') { where.push(`${scopeColumn}=?`); params.push(id); }
    else {
      const lottery = this.row<any>('SELECT dyid FROM lotteries WHERE id=?', [id]);
      if (!lottery) return { items: [], page, pageSize, total: 0, pages: 1, summary: { attempted: 0, success: 0, partial: 0, failed: 0 } };
      where.push('l.dyid=?'); params.push(lottery.dyid);
    }
    if (query.status && ['success', 'partial', 'failed'].includes(query.status)) { where.push('p.overall_status=?'); params.push(query.status); }
    if (query.search) {
      const term = `%${query.search}%`; where.push('(p.dyid LIKE ? OR l.author LIKE ? OR l.description LIKE ? OR p.comment_text LIKE ? OR p.relay_text LIKE ?)'); params.push(term, term, term, term, term);
    }
    const clause = `WHERE ${where.join(' AND ')}`; const total = Number(this.row<any>(`SELECT COUNT(*) count FROM participation_records p JOIN lotteries l ON l.id=p.lottery_id ${clause}`, params)?.count || 0);
    const items = this.rows(`SELECT p.*,l.author,l.description,l.url,l.draw_time,l.source,a.name account_name,r.status run_status,r.started_at run_started_at,j.type run_type FROM participation_records p JOIN lotteries l ON l.id=p.lottery_id JOIN accounts a ON a.id=p.account_id JOIN runs r ON r.id=p.run_id JOIN jobs j ON j.id=r.job_id ${clause} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    const summaryWhere = scope === 'run' ? 'p.run_id=?' : 'p.dyid=?'; const summaryValue = scope === 'run' ? id : this.row<any>('SELECT dyid FROM lotteries WHERE id=?', [id])?.dyid;
    const count = (status?: string) => Number(this.row<any>(`SELECT COUNT(*) count FROM participation_records p WHERE ${summaryWhere}${status ? ' AND p.overall_status=?' : ''}`, status ? [summaryValue, status] : [summaryValue])?.count || 0);
    return { items, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), summary: { attempted: count(), success: count('success'), partial: count('partial'), failed: count('failed') } };
  }
  listRunParticipations(runId: number, query: ParticipationQuery = {}) { return this.listParticipationRecords('run', runId, query); }
  listLotteryParticipations(lotteryId: number, query: ParticipationQuery = {}) { return this.listParticipationRecords('lottery', lotteryId, query); }
  listLotteryBackfillCandidates(limit = 20) { return this.rows<any>("SELECT l.*,a.cookie,a.cookie_status FROM lotteries l JOIN accounts a ON a.id=l.account_id WHERE a.enabled=1 AND a.cookie_status!='invalid' AND l.enrichment_status!='failed' AND (l.description IS NULL OR l.description='' OR l.enrichment_status='pending') ORDER BY l.id LIMIT ?", [limit]); }
  listLotteryDrawTimeCandidates(limit = 500) { return this.rows<any>("SELECT * FROM lotteries WHERE draw_time IS NULL AND official=0 AND description IS NOT NULL AND description!='' ORDER BY id DESC LIMIT ?", [limit]); }
  lotteryBackfillStats() { const total = Number(this.row<any>('SELECT COUNT(*) count FROM lotteries')?.count || 0); const pending = Number(this.row<any>("SELECT COUNT(*) count FROM lotteries WHERE enrichment_status!='failed' AND (description IS NULL OR description='' OR enrichment_status='pending')")?.count || 0); const failed = Number(this.row<any>("SELECT COUNT(*) count FROM lotteries WHERE enrichment_status='failed'")?.count || 0); return { total, pending, failed, complete: Math.max(0, total - pending - failed) }; }
  listWins(limit = 100) { return this.rows('SELECT w.*,a.name account_name FROM win_events w JOIN accounts a ON a.id=w.account_id ORDER BY w.id DESC LIMIT ?', [limit]); }
  addWinEvent(input: { accountId: number; source: string; actor: string; content: string; url: string; occurredAt: string; eventKey: string }) {
    if (this.row('SELECT id FROM win_events WHERE event_key=?', [input.eventKey])) return undefined;
    const id = this.insert('INSERT INTO win_events(account_id,source,actor,content,url,occurred_at,event_key,detected_at) VALUES (?,?,?,?,?,?,?,?)', [input.accountId, input.source, input.actor, input.content, input.url, input.occurredAt, input.eventKey, this.now()]);
    return this.row('SELECT * FROM win_events WHERE id=?', [id]);
  }
  markWinRead(id: number) { this.run('UPDATE win_events SET is_read=1 WHERE id=?', [id]); }
  addNotification(input: { accountId?: number | null; runId?: number | null; eventType: string; title: string; content: string }) { return this.insert('INSERT INTO notifications(account_id,run_id,channel,event_type,title,content,status,created_at) VALUES (?,?,?,?,?,?,?,?)', [input.accountId || null, input.runId || null, 'email', input.eventType, input.title, input.content, 'pending', this.now()]); }
  updateNotification(id: number, status: string, attempts: number, error?: string) { this.run('UPDATE notifications SET status=?,attempts=?,error=?,last_attempt_at=? WHERE id=?', [status, attempts, error || null, this.now(), id]); }
  latestNotification(accountId: number, eventType: string) { return this.row<NotificationRow>('SELECT * FROM notifications WHERE account_id=? AND event_type=? ORDER BY id DESC LIMIT 1', [accountId, eventType]); }
  listNotifications(limit = 100) { return this.rows('SELECT n.*,a.name account_name,a.uid FROM notifications n LEFT JOIN accounts a ON a.id=n.account_id ORDER BY n.id DESC LIMIT ?', [limit]); }
  listSchedules(accountId?: number) {
    const where = accountId ? 'WHERE s.account_id=?' : '';
    return this.rows<ScheduleRow & { account_name: string | null; uid: string | null }>(`SELECT s.*,a.name account_name,a.uid FROM account_schedules s JOIN accounts a ON a.id=s.account_id ${where} ORDER BY s.account_id,s.type`, accountId ? [accountId] : []);
  }
  getSchedule(id: number) { return this.row<ScheduleRow>('SELECT * FROM account_schedules WHERE id=?', [id]); }
  upsertSchedule(accountId: number, type: string, cron: string, enabled: boolean, nextRunAt: string | null, isOverride = true) {
    const now = this.now();
    this.run(`INSERT INTO account_schedules(account_id,type,cron,enabled,is_override,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,type) DO UPDATE SET cron=excluded.cron,enabled=excluded.enabled,is_override=excluded.is_override,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`, [accountId, type, cron, enabled ? 1 : 0, isOverride ? 1 : 0, nextRunAt, now, now]);
    return this.row<ScheduleRow>('SELECT * FROM account_schedules WHERE account_id=? AND type=?', [accountId, type])!;
  }
  syncScheduleRows(rows: ScheduleSeed[], mode: 'missing' | 'inherited' | 'all') {
    const now = this.now(); this.db.run('BEGIN');
    try {
      for (const row of rows) {
        const existing = this.row<ScheduleRow>('SELECT * FROM account_schedules WHERE account_id=? AND type=?', [row.accountId, row.type]);
        if (!existing) {
          this.db.run('INSERT INTO account_schedules(account_id,type,cron,enabled,is_override,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [row.accountId, row.type, row.cron, row.enabled ? 1 : 0, row.isOverride ? 1 : 0, row.nextRunAt, now, now]);
        } else {
          const inheritedChanged = mode === 'inherited' && existing.is_override === 0 && (
            existing.cron !== row.cron || Boolean(existing.enabled) !== row.enabled ||
            (row.enabled && !existing.next_run_at) || (!row.enabled && existing.next_run_at !== null)
          );
          if (mode !== 'all' && !inheritedChanged) continue;
          this.db.run('UPDATE account_schedules SET cron=?,enabled=?,is_override=?,next_run_at=?,updated_at=? WHERE id=?', [row.cron, row.enabled ? 1 : 0, row.isOverride ? 1 : 0, row.nextRunAt, now, existing.id]);
        }
      }
      this.db.run('COMMIT'); this.flush();
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
  }
  deleteSchedule(id: number) { this.run('DELETE FROM account_schedules WHERE id=?', [id]); }
  listDueSchedules(now: string) { return this.rows<ScheduleRow>('SELECT * FROM account_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at,id', [now]); }
  markScheduleTriggered(id: number, jobId: number | null, nextRunAt: string) { this.run('UPDATE account_schedules SET last_run_at=?,last_job_id=?,next_run_at=?,updated_at=? WHERE id=?', [this.now(), jobId, nextRunAt, this.now(), id]); }
  stats() { const today = new Date().toISOString().slice(0, 10); const count = (sql: string, params: any[] = []) => Number(this.row<any>(sql, params)?.count || 0); return { accounts: count('SELECT COUNT(*) count FROM accounts'), activeAccounts: count("SELECT COUNT(*) count FROM accounts WHERE enabled=1 AND cookie_status='valid'"), lotteriesToday: count('SELECT COUNT(*) count FROM lotteries WHERE created_at LIKE ?', [`${today}%`]), winsUnread: count('SELECT COUNT(*) count FROM win_events WHERE is_read=0'), runsToday: count('SELECT COUNT(*) count FROM runs WHERE started_at LIKE ?', [`${today}%`]), successToday: count("SELECT COUNT(*) count FROM runs WHERE started_at LIKE ? AND status='success'", [`${today}%`]) }; }
}
