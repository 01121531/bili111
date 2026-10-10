import { EventEmitter } from 'node:events';
import { AppDatabase } from './db';
import { EngineRunner } from './engine';

export class SerialScheduler {
  queue: number[] = [];
  running = false;
  events = new EventEmitter();
  engine: EngineRunner;
  constructor(private db: AppDatabase) { this.engine = new EngineRunner(db, event => this.events.emit('event', event)); }
  enqueue(accountId: number, type: string) { const job = this.db.createJob(accountId, type); this.queue.push(job.id); this.events.emit('event', { type: 'job', payload: job }); this.pump(); return job; }
  cancel(jobId: number) { if (this.engine.cancel(jobId)) return true; this.db.updateJob(jobId, 'cancelled'); this.queue = this.queue.filter(id => id !== jobId); return true; }
  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const jobId = this.queue.shift()!; const job = this.db.getJob(jobId); if (!job || job.status !== 'pending') continue;
      const account = this.db.getAccount(job.account_id); if (!account || !account.enabled) { this.db.updateJob(jobId, 'skipped', { error: '账号已停用或不存在', finishedAt: new Date().toISOString() }); continue; }
      const startedAt = new Date().toISOString(); this.db.updateJob(jobId, 'running', { startedAt });
      const runId = this.db.createRun(jobId, account.id); this.events.emit('event', { type: 'job', payload: { ...job, status: 'running', run_id: runId } });
      try {
        const result = await this.engine.run(jobId, runId, account, job.type, this.db.getConfig(account.id));
        const status = result.code === 0 ? 'success' : 'failed';
        this.db.finishRun(runId, status, { discovered_count: result.discovered, attempted_count: result.attempted, success_count: result.success, error_count: result.errors });
        this.db.updateJob(jobId, status, { finishedAt: new Date().toISOString(), error: status === 'failed' ? `退出码 ${result.code}` : undefined });
        this.events.emit('event', { type: 'job', payload: this.db.getJob(jobId) });
      } catch (error) {
        this.db.finishRun(runId, 'failed', { error: String(error) }); this.db.updateJob(jobId, 'failed', { finishedAt: new Date().toISOString(), error: String(error) });
      }
    }
    this.running = false;
  }
}
