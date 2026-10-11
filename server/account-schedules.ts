import { CronExpressionParser } from 'cron-parser';
import { AppDatabase } from './db';
import { SerialScheduler } from './scheduler';

export const scheduleJobTypes = ['start', 'check', 'clear', 'account'] as const;
export type ScheduleJobType = typeof scheduleJobTypes[number];

export function nextScheduleRun(cron: string, from = new Date()) {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error('Cron 必须使用 5 段格式：分 时 日 月 周');
  return CronExpressionParser.parse(cron, { currentDate: from, tz: 'Asia/Shanghai' }).next().toDate().toISOString();
}

export class AccountScheduleService {
  private timer: NodeJS.Timeout;
  private checking = false;

  constructor(private db: AppDatabase, private scheduler: SerialScheduler) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref();
  }

  save(accountId: number, type: ScheduleJobType, cron: string, enabled: boolean) {
    const nextRunAt = enabled ? nextScheduleRun(cron) : null;
    return this.db.upsertSchedule(accountId, type, cron, enabled, nextRunAt);
  }

  stop() { clearInterval(this.timer); }

  private async tick() {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = new Date();
      for (const schedule of this.db.listDueSchedules(now.toISOString())) {
        const account = this.db.getAccount(schedule.account_id);
        const job = account?.enabled ? this.scheduler.enqueue(schedule.account_id, schedule.type) : null;
        this.db.markScheduleTriggered(schedule.id, job?.id || null, nextScheduleRun(schedule.cron, now));
      }
    } finally { this.checking = false; }
  }
}
