import { CronExpressionParser } from 'cron-parser';
import { AppDatabase, ScheduleSeed } from './db';
import { SerialScheduler } from './scheduler';

export const scheduleJobTypes = ['start', 'check', 'clear', 'account', 'comment_backfill', 'daily', 'live_automation', 'streaming'] as const;
export type ScheduleJobType = typeof scheduleJobTypes[number];
export type ScheduleTemplate = Record<ScheduleJobType, { cron: string; enabled: boolean }>;

export const builtInScheduleDefaults: ScheduleTemplate = {
  start: { cron: '0 */6 * * *', enabled: false },
  check: { cron: '*/30 * * * *', enabled: false },
  clear: { cron: '0 3 * * *', enabled: false },
  account: { cron: '0 8 * * *', enabled: false },
  comment_backfill: { cron: '0 4 * * *', enabled: true },
  daily: { cron: '0 5 * * *', enabled: true },
  live_automation: { cron: '0 20 * * *', enabled: false },
  streaming: { cron: '0 21 * * *', enabled: false }
};

export function nextScheduleRun(cron: string, from = new Date()) {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error('Cron 必须使用 5 段格式：分 时 日 月 周');
  return CronExpressionParser.parse(cron, { currentDate: from, tz: 'Asia/Shanghai' }).next().toDate().toISOString();
}

export function validateScheduleDefaults(input: unknown, base: ScheduleTemplate = builtInScheduleDefaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('默认定时任务格式无效');
  const source = input as Record<string, any>; const result = structuredClone(base);
  for (const type of scheduleJobTypes) {
    if (source[type] === undefined) continue;
    const cron = String(source[type]?.cron || '').trim(); nextScheduleRun(cron);
    result[type] = { cron, enabled: source[type]?.enabled === true };
  }
  return result;
}

export class AccountScheduleService {
  private timer: NodeJS.Timeout;
  private checking = false;

  constructor(private db: AppDatabase, private scheduler: SerialScheduler) {
    this.normalizeStoredDefaults();
    this.syncInherited(false);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref();
  }

  getDefaults() {
    try { return validateScheduleDefaults(JSON.parse(this.db.getSetting('default_account_schedules') || '{}')); }
    catch { return structuredClone(builtInScheduleDefaults); }
  }

  listDefaults() {
    const defaults = this.getDefaults();
    return scheduleJobTypes.map(type => ({ type, ...defaults[type], next_run_at: defaults[type].enabled ? nextScheduleRun(defaults[type].cron) : null, is_override: 0, inherited: true }));
  }

  listAccount(accountId: number) {
    this.ensureAccount(accountId);
    return this.db.listSchedules(accountId).map(row => ({ ...row, inherited: row.is_override === 0 }));
  }

  save(accountId: number, type: ScheduleJobType, cron: string, enabled: boolean) {
    const nextRunAt = enabled ? nextScheduleRun(cron) : null;
    return { ...this.db.upsertSchedule(accountId, type, cron, enabled, nextRunAt, true), inherited: false };
  }

  saveDefaults(input: unknown) {
    const defaults = validateScheduleDefaults(input, this.getDefaults());
    this.db.setSetting('default_account_schedules', JSON.stringify(defaults));
    this.syncInherited(false);
    return this.listDefaults();
  }

  reset(accountId: number, type: ScheduleJobType) {
    const item = this.getDefaults()[type];
    const row = this.db.upsertSchedule(accountId, type, item.cron, item.enabled, item.enabled ? nextScheduleRun(item.cron) : null, false);
    return { ...row, inherited: true };
  }

  ensureAccount(accountId: number) { this.syncAccounts([accountId], 'missing'); }

  applyDefaultsToAll() { this.syncInherited(true); return this.db.listAccounts().length; }

  stop() { clearInterval(this.timer); }

  private normalizeStoredDefaults() {
    const defaults = this.getDefaults();
    if (!defaults.clear.enabled && defaults.clear.cron === '0 3 * * 0') defaults.clear.cron = builtInScheduleDefaults.clear.cron;
    this.db.setSetting('default_account_schedules', JSON.stringify(defaults));
  }

  private syncInherited(forceAll: boolean) {
    this.syncAccounts(this.db.listAccounts().map(account => account.id), forceAll ? 'all' : 'inherited');
  }

  private syncAccounts(accountIds: number[], mode: 'missing' | 'inherited' | 'all') {
    const defaults = this.getDefaults(); const rows: ScheduleSeed[] = [];
    for (const accountId of accountIds) for (const type of scheduleJobTypes) {
      const item = defaults[type];
      rows.push({ accountId, type, cron: item.cron, enabled: item.enabled, nextRunAt: item.enabled ? nextScheduleRun(item.cron) : null, isOverride: false });
    }
    if (rows.length) this.db.syncScheduleRows(rows, mode);
  }

  private async tick() {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = new Date();
      for (const schedule of this.db.listDueSchedules(now.toISOString())) {
        const account = this.db.getAccount(schedule.account_id);
        const hasWork = schedule.type !== 'comment_backfill' || this.db.listCommentBackfillCandidates(schedule.account_id, 1).length > 0;
        const job = account?.enabled && hasWork ? this.scheduler.enqueue(schedule.account_id, schedule.type, schedule.type === 'comment_backfill' ? { limit: 20 } : undefined) : null;
        this.db.markScheduleTriggered(schedule.id, job?.id || null, nextScheduleRun(schedule.cron, now));
      }
    } finally { this.checking = false; }
  }
}
