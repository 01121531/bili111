import { AppDatabase } from './db';
import { decrypt } from './security';
import { getDynamicDetail, getLotteryDrawTime } from './bili';

const BATCH_SIZE = 20;

export function parseDrawTime(text: string, sourceCreatedAt?: number | null) {
  const value = String(text || '');
  const match = value.match(/(?:开奖(?:时间)?|截至|截止)[^\d]{0,10}(?:(\d{4})[年./-])?(\d{1,2})[月./-](\d{1,2})日?(?:\s*(\d{1,2})(?:[:点时](\d{1,2})?)?)?/i)
    || value.match(/(?:(\d{4})[年./-])?(\d{1,2})[月./-](\d{1,2})日?(?:\s*(\d{1,2})(?:[:点时](\d{1,2})?)?)?[^，。\n]{0,10}(?:开奖|开抽|抽(?:取|出|一|送)?)/i);
  if (!match) return null;
  const source = sourceCreatedAt ? new Date(sourceCreatedAt * 1000) : new Date();
  let year = Number(match[1] || source.getFullYear());
  const month = Number(match[2]); const day = Number(match[3]); const hour = Number(match[4] || 0); const minute = Number(match[5] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  let timestamp = Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;
  if (!match[1] && sourceCreatedAt && timestamp < sourceCreatedAt - 30 * 86400) {
    year += 1; timestamp = Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;
  }
  const check = new Date((timestamp + 8 * 3600) * 1000);
  return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day ? timestamp : null;
}

export class LotteryEnricher {
  private running = false;
  private timer?: NodeJS.Timeout;
  private pausedUntil = 0;
  private lastError = '';
  constructor(private db: AppDatabase, private acquireQueue: () => boolean, private releaseQueue: () => void, private fetchDetail = getDynamicDetail, private fetchDrawTime = getLotteryDrawTime, private delayMs = 1500) {}

  status() { return { ...this.db.lotteryBackfillStats(), running: this.running, pausedUntil: this.pausedUntil || null, lastError: this.lastError || null }; }

  start() {
    this.reparseKnownDrawTimes();
    this.timer = setTimeout(() => void this.runBatch(), 10000);
  }

  private reparseKnownDrawTimes() {
    for (const row of this.db.listLotteryDrawTimeCandidates()) {
      const drawTime = parseDrawTime(row.description, row.source_created_at);
      if (drawTime) this.db.upsertLottery(row.account_id, { dyid: String(row.dyid), drawTime });
    }
  }

  stop() { if (this.timer) clearTimeout(this.timer); }

  private schedule(milliseconds = 60000) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runBatch(), milliseconds);
  }

  async runBatch(manual = false) {
    if (this.running) return { ...this.status(), accepted: false, reason: '补全任务正在运行' };
    if (!manual && this.pausedUntil > Date.now()) { this.schedule(Math.min(60000, this.pausedUntil - Date.now())); return { ...this.status(), accepted: false, reason: '补全任务处于退避期' }; }
    if (!this.acquireQueue()) { this.schedule(30000); return { ...this.status(), accepted: false, reason: '账号任务队列正在运行' }; }
    const rows = this.db.listLotteryBackfillCandidates(BATCH_SIZE);
    if (!rows.length) { this.releaseQueue(); return { ...this.status(), accepted: true, processed: 0 }; }

    this.running = true; let processed = 0;
    try {
      for (const row of rows) {
        const result = await this.fetchDetail(decrypt(row.cookie), String(row.dyid));
        if (!result.ok) {
          this.lastError = result.error;
          if (result.retryable) {
            this.pausedUntil = Date.now() + (result.risk ? 30 : 5) * 60000;
            break;
          }
          this.db.upsertLottery(row.account_id, { dyid: String(row.dyid), enrichmentStatus: 'failed', resultReason: result.error });
          processed += 1;
          continue;
        }
        const detail = result.detail;
        const drawTime = detail.official ? await this.fetchDrawTime(detail.dyid) : parseDrawTime(detail.description, detail.sourceCreatedAt);
        this.db.upsertLottery(row.account_id, { ...detail, dyid: String(row.dyid), drawTime, enrichmentStatus: 'complete' });
        processed += 1;
        if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
      }
      if (processed) { this.lastError = ''; this.pausedUntil = 0; }
      return { ...this.status(), accepted: true, processed };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.pausedUntil = Date.now() + 5 * 60000;
      return { ...this.status(), accepted: false, reason: this.lastError, processed };
    } finally {
      this.running = false;
      this.releaseQueue();
      if (this.db.lotteryBackfillStats().pending > 0) this.schedule(this.pausedUntil > Date.now() ? Math.min(60000, this.pausedUntil - Date.now()) : 60000);
    }
  }
}
