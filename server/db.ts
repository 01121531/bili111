import initSqlJs, { Database as SqlDatabase } from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashPassword } from './security';

export type AccountRow = { id: number; uid: string | null; name: string | null; note: string; cookie: string; cookie_status: string; enabled: number; profile_json: string | null; last_verified_at: string | null; verification_error: string | null; created_at: string; updated_at: string };
export type JobRow = { id: number; account_id: number; type: string; status: string; requested_at: string; started_at: string | null; finished_at: string | null; error: string | null };
export type ScheduleRow = { id: number; account_id: number; type: string; cron: string; enabled: number; last_run_at: string | null; next_run_at: string | null; last_job_id: number | null; created_at: string; updated_at: string };
export type NotificationRow = { id: number; account_id: number | null; run_id: number | null; channel: string; event_type: string; title: string; content: string; status: string; error: string | null; attempts: number; last_attempt_at: string | null; created_at: string };
export type LotteryInput = { dyid: string; source?: string; author?: string; description?: string; drawTime?: number | null; official?: boolean; status?: string; resultReason?: string; url?: string; sourceCreatedAt?: number | null; enrichmentStatus?: string };

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
      CREATE TABLE IF NOT EXISTS lotteries (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, dyid TEXT NOT NULL, source TEXT, author TEXT, description TEXT, draw_time INTEGER, official INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'discovered', result_reason TEXT, url TEXT, source_created_at INTEGER, enrichment_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT, UNIQUE(account_id,dyid));
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
    this.addColumn('lotteries', "enrichment_status TEXT NOT NULL DEFAULT 'pending'");
    this.addColumn('lotteries', 'updated_at TEXT');
    this.db.run("UPDATE lotteries SET source='legacy' WHERE source IN ('start','discover')");
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
  finishRun(id: number, status: string, stats: Record<string, number | string> = {}) { this.run('UPDATE runs SET status=?,discovered_count=?,attempted_count=?,success_count=?,error_count=?,finished_at=?,error=? WHERE id=?', [status, stats.discovered_count || 0, stats.attempted_count || 0, stats.success_count || 0, stats.error_count || 0, this.now(), stats.error || null, id]); }
  listRuns(limit = 50) { return this.rows('SELECT r.*,a.name account_name,a.uid,j.type FROM runs r JOIN accounts a ON a.id=r.account_id JOIN jobs j ON j.id=r.job_id ORDER BY r.id DESC LIMIT ?', [limit]); }
  addLog(runId: number, accountId: number, level: string, context: string, message: string) { const createdAt = this.now(); const id = this.insert('INSERT INTO logs(run_id,account_id,level,context,message,created_at) VALUES (?,?,?,?,?,?)', [runId, accountId, level, context, message, createdAt]); return { id, run_id: runId, account_id: accountId, level, context, message, created_at: createdAt }; }
  listLogs(runId: number, limit = 500) { return this.rows('SELECT * FROM logs WHERE run_id=? ORDER BY id ASC LIMIT ?', [runId, limit]); }
  addLottery(accountId: number, dyid: string, source = 'runtime', url = `https://t.bilibili.com/${dyid}`) { return this.upsertLottery(accountId, { dyid, source, url }); }
  upsertLottery(accountId: number, input: LotteryInput) {
    const now = this.now(); const current = this.row<any>('SELECT * FROM lotteries WHERE account_id=? AND dyid=?', [accountId, input.dyid]);
    if (!current) {
      this.run('INSERT INTO lotteries(account_id,dyid,source,author,description,draw_time,official,status,result_reason,url,source_created_at,enrichment_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [accountId, input.dyid, input.source || 'runtime', input.author || null, input.description || null, input.drawTime && input.drawTime > 0 ? input.drawTime : null, input.official ? 1 : 0, input.status || 'discovered', input.resultReason || null, input.url || `https://t.bilibili.com/${input.dyid}`, input.sourceCreatedAt || null, input.enrichmentStatus || (input.description ? 'complete' : 'pending'), now, now]);
    } else {
      this.run('UPDATE lotteries SET source=?,author=?,description=?,draw_time=?,official=?,status=?,result_reason=?,url=?,source_created_at=?,enrichment_status=?,updated_at=? WHERE id=?', [input.source || current.source, input.author || current.author, input.description || current.description, input.drawTime && input.drawTime > 0 ? input.drawTime : current.draw_time, input.official === undefined ? current.official : (input.official ? 1 : 0), input.status || current.status, input.resultReason === undefined ? current.result_reason : input.resultReason, input.url || current.url, input.sourceCreatedAt || current.source_created_at, input.enrichmentStatus || (input.description ? 'complete' : current.enrichment_status), now, current.id]);
    }
    return this.row<any>('SELECT * FROM lotteries WHERE account_id=? AND dyid=?', [accountId, input.dyid]);
  }
  listLotteries(limit = 100) { return this.rows('SELECT l.*,a.name account_name FROM lotteries l JOIN accounts a ON a.id=l.account_id ORDER BY l.id DESC LIMIT ?', [limit]); }
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
  upsertSchedule(accountId: number, type: string, cron: string, enabled: boolean, nextRunAt: string | null) {
    const now = this.now();
    this.run(`INSERT INTO account_schedules(account_id,type,cron,enabled,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id,type) DO UPDATE SET cron=excluded.cron,enabled=excluded.enabled,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`, [accountId, type, cron, enabled ? 1 : 0, nextRunAt, now, now]);
    return this.row<ScheduleRow>('SELECT * FROM account_schedules WHERE account_id=? AND type=?', [accountId, type])!;
  }
  deleteSchedule(id: number) { this.run('DELETE FROM account_schedules WHERE id=?', [id]); }
  listDueSchedules(now: string) { return this.rows<ScheduleRow>('SELECT * FROM account_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at,id', [now]); }
  markScheduleTriggered(id: number, jobId: number | null, nextRunAt: string) { this.run('UPDATE account_schedules SET last_run_at=?,last_job_id=?,next_run_at=?,updated_at=? WHERE id=?', [this.now(), jobId, nextRunAt, this.now(), id]); }
  stats() { const today = new Date().toISOString().slice(0, 10); const count = (sql: string, params: any[] = []) => Number(this.row<any>(sql, params)?.count || 0); return { accounts: count('SELECT COUNT(*) count FROM accounts'), activeAccounts: count("SELECT COUNT(*) count FROM accounts WHERE enabled=1 AND cookie_status='valid'"), lotteriesToday: count('SELECT COUNT(*) count FROM lotteries WHERE created_at LIKE ?', [`${today}%`]), winsUnread: count('SELECT COUNT(*) count FROM win_events WHERE is_read=0'), runsToday: count('SELECT COUNT(*) count FROM runs WHERE started_at LIKE ?', [`${today}%`]), successToday: count("SELECT COUNT(*) count FROM runs WHERE started_at LIKE ? AND status='success'", [`${today}%`]) }; }
}
