import { EventEmitter } from 'node:events';
import { AppDatabase } from './db';
import { EngineRunner } from './engine';
import { AiService } from './ai';
import { EmailNotificationService } from './notifications';

export class SerialScheduler {
  queue: number[] = [];
  running = false;
  private maintenance = false;
  events = new EventEmitter();
  engine: EngineRunner;
  constructor(private db: AppDatabase, ai = new AiService(db), notifications = new EmailNotificationService(db)) {
    this.db.recoverInterruptedJobs();
    this.engine = new EngineRunner(db, event => this.publish(event), ai, notifications);
  }
  private publish(event: object) {
    try { this.events.emit('event', event); } catch { /* disconnected SSE clients must not stop the queue */ }
  }
  enqueue(accountId: number, type: string) { const job = this.db.createJob(accountId, type); this.queue.push(job.id); this.publish({ type: 'job', payload: job }); this.pump(); return job; }
  isIdle() { return !this.running && !this.maintenance && this.queue.length === 0; }
  beginMaintenance() { if (!this.isIdle()) return false; this.maintenance = true; return true; }
  endMaintenance() { this.maintenance = false; void this.pump(); }
  cancel(jobId: number) { if (this.engine.cancel(jobId)) return true; this.db.updateJob(jobId, 'cancelled'); this.queue = this.queue.filter(id => id !== jobId); return true; }
  async pump() {
    if (this.running || this.maintenance) return;
    this.running = true;
    while (this.queue.length) {
      const jobId = this.queue.shift()!; const job = this.db.getJob(jobId); if (!job || job.status !== 'pending') continue;
      const account = this.db.getAccount(job.account_id); if (!account || !account.enabled) { this.db.updateJob(jobId, 'skipped', { error: '账号已停用或不存在', finishedAt: new Date().toISOString() }); continue; }
      const startedAt = new Date().toISOString(); this.db.updateJob(jobId, 'running', { startedAt });
      const runId = this.db.createRun(jobId, account.id); this.publish({ type: 'job', payload: { ...job, status: 'running', run_id: runId } });
      try {
        const result = await this.engine.run(jobId, runId, account, job.type, this.db.getConfig(account.id));
        const status = result.code === 0 ? 'success' : 'failed';
        this.db.finishRun(runId, status, { discovered_count: result.discovered, candidate_count: result.candidates, attempted_count: result.attempted, success_count: result.success, participated_count: result.success, partial_count: result.partial, failed_count: result.failed, error_count: result.errors });
        this.db.updateJob(jobId, status, { finishedAt: new Date().toISOString(), error: status === 'failed' ? `退出码 ${result.code}` : undefined });
        this.publish({ type: 'job', payload: this.db.getJob(jobId) });
      } catch (error) {
        this.db.finishRun(runId, 'failed', { error: String(error) }); this.db.updateJob(jobId, 'failed', { finishedAt: new Date().toISOString(), error: String(error) });
      }
    }
    this.running = false;
  }
}
