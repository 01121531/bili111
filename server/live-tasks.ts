import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decrypt } from './security';
import { AppDatabase, type AccountRow } from './db';
import { DailyBiliClient, type DailyResult } from './daily-bili';
import { mergeDailyConfig, type DailyConfig } from './daily';

export const mediaDirectory = join(process.cwd(), 'data', 'daily-media');
export const allowedMediaExtensions = new Set(['.mp4', '.mkv', '.avi', '.flv', '.mov', '.ts', '.mpeg', '.mpg', '.m4v', '.webm']);

function wait(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()); }
function clean(value: unknown, limit = 500) { return String(value ?? '').replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••').slice(0, limit); }

function commandResult(command: string, args: string[], timeoutMs = 15000) {
  return new Promise<{ ok: boolean; output: string }>(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(command, args, { windowsHide: true }); } catch (error) { resolve({ ok: false, output: clean(error) }); return; }
    let output = ''; const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, output: clean(error) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, output: clean(output, 1000) }); });
  });
}

export async function ffmpegStatus() {
  const ffmpeg = await commandResult(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']);
  const ffprobe = await commandResult(process.env.FFPROBE_PATH || 'ffprobe', ['-version']);
  return { available: ffmpeg.ok && ffprobe.ok, ffmpeg: ffmpeg.ok, ffprobe: ffprobe.ok, error: ffmpeg.ok && ffprobe.ok ? null : '服务器缺少可用的 ffmpeg 或 ffprobe' };
}

export async function probeMedia(path: string) {
  const result = await commandResult(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], 30000);
  const duration = Number(result.output.trim());
  return result.ok && Number.isFinite(duration) && duration > 0 ? { ok: true, duration } : { ok: false, duration: null, error: result.output || 'ffprobe 无法识别该素材' };
}

export function safeMediaName(originalName: string) {
  const extension = extname(originalName).toLowerCase(); if (!allowedMediaExtensions.has(extension)) throw new Error('不支持的媒体格式');
  return `${Date.now()}-${randomBytes(8).toString('hex')}${extension}`;
}

type Publish = (event: object) => void;

export class LongTaskManager {
  private controllers = new Map<number, AbortController>();
  private children = new Map<number, ChildProcessWithoutNullStreams>();
  private accountSessions = new Map<number, number>();
  private active = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(private db: AppDatabase, private publish: Publish, private normalBusy: (accountId: number) => boolean, private wakeNormal: () => void) {
    mkdirSync(mediaDirectory, { recursive: true });
  }

  isAccountBusy(accountId: number) { return this.accountSessions.has(accountId); }
  hasActive() { return this.accountSessions.size > 0; }

  enqueue(accountId: number, type: 'live_automation' | 'streaming', options: Record<string, unknown> = {}) {
    if (this.shuttingDown) throw new Error('服务正在停止，暂不接受新的长任务');
    const existing = this.db.listLongTaskSessions(accountId, 10).find(item => ['pending', 'running', 'cancelling'].includes(String(item.status)));
    if (existing) throw new Error(`当前账号已有长任务：${existing.type}`);
    const job = this.db.createJob(accountId, type, options); const session = this.db.createLongTaskSession(job.id, accountId, type, options);
    this.publish({ type: 'job', payload: job });
    const task = this.start(Number(session!.id)); this.active.add(task); void task.finally(() => this.active.delete(task));
    return { job, session };
  }

  cancel(sessionId: number) {
    const session = this.db.requestLongTaskCancel(sessionId); if (!session) return false;
    this.controllers.get(sessionId)?.abort(); this.children.get(sessionId)?.kill('SIGTERM'); this.publish({ type: 'long-task', payload: session }); return true;
  }

  cancelByJob(jobId: number) { const session = this.db.getLongTaskSessionByJob(jobId); return session ? this.cancel(Number(session.id)) : false; }
  async shutdown() {
    this.shuttingDown = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const child of this.children.values()) child.kill('SIGTERM');
    await Promise.allSettled([...this.active]);
  }

  private config(accountId: number): DailyConfig {
    let global: Record<string, any> = {}; try { global = JSON.parse(this.db.getSetting('global_config') || '{}'); } catch { global = {}; }
    const account = this.db.getConfig(accountId) as Record<string, any>;
    return mergeDailyConfig(account.daily_tasks, global.daily_tasks);
  }

  private async record(accountId: number, runId: number, action: string, targetId: string, result: DailyResult) {
    const row = this.db.upsertDailyAction(accountId, runId, today(), { action, targetId, status: result.status, providerCode: result.providerCode, providerMessage: result.providerMessage, errorType: result.errorType, httpStatus: result.httpStatus, transportCode: result.transportCode, retryable: result.retryable, attemptCount: result.attemptCount || result.attempts?.length || 1, reason: result.reason });
    for (const [index, attempt] of (result.attempts || []).entries()) this.db.addDailyActionAttempt(accountId, runId, today(), action, targetId, index + 1, attempt);
    this.db.addLog(runId, accountId, ['failed', 'throttled'].includes(result.status) ? 'error' : 'info', action, `${targetId ? `${targetId}：` : ''}${clean(result.reason)}`);
    this.publish({ type: 'daily-action', payload: row }); return row;
  }

  private async start(sessionId: number) {
    const session = this.db.getLongTaskSession(sessionId); if (!session) return;
    if (session.cancel_requested || session.status === 'cancelled') { this.db.updateJob(session.job_id, 'cancelled', { finishedAt: new Date().toISOString(), error: '任务在启动前已取消' }); return; }
    const account = this.db.getAccount(Number(session.account_id)); if (!account || !account.enabled) { this.db.updateLongTaskSession(sessionId, 'skipped', { finishedAt: new Date().toISOString(), error: '账号已停用或不存在' }); this.db.updateJob(session.job_id, 'skipped', { finishedAt: new Date().toISOString(), error: '账号已停用或不存在' }); return; }
    const startDelayMs = Math.max(0, Math.min(3_600_000, Number(session.details?.startDelayMs) || 0));
    const startAt = Date.now() + startDelayMs;
    while (Date.now() < startAt) {
      const latest = this.db.getLongTaskSession(sessionId);
      if (latest?.cancel_requested || this.shuttingDown) {
        const reason = this.shuttingDown ? '服务停止前任务尚未启动' : '任务在启动前已取消';
        this.db.updateLongTaskSession(sessionId, 'cancelled', { finishedAt: new Date().toISOString(), error: reason, cancelRequested: true });
        this.db.updateJob(session.job_id, 'cancelled', { finishedAt: new Date().toISOString(), error: reason });
        this.publish({ type: 'long-task', payload: this.db.getLongTaskSession(sessionId) });
        return;
      }
      await wait(Math.min(250, Math.max(1, startAt - Date.now())));
    }
    while (this.normalBusy(account.id)) {
      const latest = this.db.getLongTaskSession(sessionId);
      if (latest?.cancel_requested || this.shuttingDown) {
        const reason = this.shuttingDown ? '服务停止前任务尚未启动' : '任务在启动前已取消';
        this.db.updateLongTaskSession(sessionId, 'cancelled', { finishedAt: new Date().toISOString(), error: reason, cancelRequested: true });
        this.db.updateJob(session.job_id, 'cancelled', { finishedAt: new Date().toISOString(), error: reason });
        this.publish({ type: 'long-task', payload: this.db.getLongTaskSession(sessionId) });
        return;
      }
      await wait(250);
    }
    const latest = this.db.getLongTaskSession(sessionId);
    if (latest?.cancel_requested || this.shuttingDown) {
      const reason = this.shuttingDown ? '服务停止前任务尚未启动' : '任务在启动前已取消';
      this.db.updateLongTaskSession(sessionId, 'cancelled', { finishedAt: new Date().toISOString(), error: reason, cancelRequested: true });
      this.db.updateJob(session.job_id, 'cancelled', { finishedAt: new Date().toISOString(), error: reason });
      this.publish({ type: 'long-task', payload: this.db.getLongTaskSession(sessionId) });
      return;
    }
    const controller = new AbortController(); this.controllers.set(sessionId, controller); this.accountSessions.set(account.id, sessionId);
    const startedAt = new Date().toISOString(); this.db.updateJob(session.job_id, 'running', { startedAt }); const runId = this.db.createRun(session.job_id, account.id);
    this.db.updateLongTaskSession(sessionId, 'running', { runId, startedAt, heartbeatAt: startedAt });
    const heartbeat = setInterval(() => this.db.updateLongTaskSession(sessionId, 'running', { heartbeatAt: new Date().toISOString() }), 15000); heartbeat.unref();
    try {
      const config = this.config(account.id); const client = new DailyBiliClient(decrypt(account.cookie), config);
      const login = await client.validate(); await this.record(account.id, runId, 'daily_login', '', login.result); if (!login.ok) throw new Error(login.result.reason);
      if (session.type === 'live_automation') await this.runLive(sessionId, account, runId, client, config, controller.signal);
      else await this.runStreaming(sessionId, account, runId, client, config, controller.signal);
      const cancelled = controller.signal.aborted; const status = cancelled ? 'cancelled' : 'success';
      const actions = this.db.listDailyActions(runId) as any[]; const failed = actions.filter(item => ['failed', 'throttled'].includes(item.status)).length; const success = actions.filter(item => ['success', 'completed'].includes(item.status)).length;
      this.db.finishRun(runId, failed && !cancelled ? 'failed' : status, { discovered_count: actions.length, candidate_count: actions.length, attempted_count: actions.length, success_count: success, failed_count: failed, error_count: failed });
      this.db.updateJob(session.job_id, failed && !cancelled ? 'failed' : status, { finishedAt: new Date().toISOString(), error: failed ? `${failed} 个动作失败` : undefined });
      this.db.updateLongTaskSession(sessionId, failed && !cancelled ? 'failed' : status, { finishedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), error: failed ? `${failed} 个动作失败` : null });
    } catch (error) {
      const cancelled = controller.signal.aborted; const status = cancelled ? 'cancelled' : 'failed'; const reason = clean(error);
      this.db.finishRun(runId, status, { error: reason, error_count: cancelled ? 0 : 1, failed_count: cancelled ? 0 : 1 }); this.db.updateJob(session.job_id, status, { finishedAt: new Date().toISOString(), error: reason }); this.db.updateLongTaskSession(sessionId, status, { finishedAt: new Date().toISOString(), error: reason });
    } finally {
      clearInterval(heartbeat); this.controllers.delete(sessionId); this.children.delete(sessionId); this.accountSessions.delete(account.id); this.publish({ type: 'long-task', payload: this.db.getLongTaskSession(sessionId) }); this.wakeNormal();
    }
  }

  private async runLive(sessionId: number, account: AccountRow, runId: number, client: DailyBiliClient, config: DailyConfig, signal: AbortSignal) {
    if (!config.liveAutomation.enabled) { await this.record(account.id, runId, 'live_automation', '', { status: 'skipped', reason: '长运行直播任务总开关已关闭' }); return; }
    const result = await client.runLiveAutomation(signal, async (action, targetId, item) => { await this.record(account.id, runId, action, targetId, item); this.db.updateLongTaskSession(sessionId, 'running', { heartbeatAt: new Date().toISOString(), details: { action, targetId, reason: item.reason } }); });
    await this.record(account.id, runId, 'live_automation', '', result);
  }

  private async runStreaming(sessionId: number, account: AccountRow, runId: number, client: DailyBiliClient, config: DailyConfig, signal: AbortSignal) {
    if (!config.streaming.enabled) { await this.record(account.id, runId, 'streaming', '', { status: 'skipped', reason: '自动开播未启用' }); return; }
    const status = await ffmpegStatus(); if (!status.available) throw new Error(status.error || 'ffmpeg 不可用');
    const media = config.streaming.mediaId ? this.db.getMediaAsset(config.streaming.mediaId) : undefined;
    if (!media || media.probe_status !== 'ready') throw new Error('所选推流素材不存在或未通过检查');
    const path = join(mediaDirectory, media.stored_name); if (!existsSync(path)) throw new Error('推流素材文件不存在');
    const prepared = await client.prepareStream(); await this.record(account.id, runId, 'stream_start', String(prepared.roomId || ''), prepared.result);
    if (!prepared.pushUrl || !prepared.roomId || prepared.result.status !== 'success') throw new Error(prepared.result.reason);
    let child: ChildProcessWithoutNullStreams | null = null; let stderr = ''; const timeout = setTimeout(() => this.controllers.get(sessionId)?.abort(), config.streaming.maxDurationMinutes * 60000);
    try {
      child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-re', '-stream_loop', '-1', '-i', path, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-f', 'flv', prepared.pushUrl], { windowsHide: true }); this.children.set(sessionId, child);
      child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); this.db.updateLongTaskSession(sessionId, 'running', { heartbeatAt: new Date().toISOString(), details: { mediaId: media.id, roomId: prepared.roomId, ffmpeg: clean(stderr, 500) } }); });
      const code = await new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve); signal.addEventListener('abort', () => child?.kill('SIGTERM'), { once: true }); });
      if (!signal.aborted && code !== 0) throw new Error(`ffmpeg 异常退出（${code}）：${clean(stderr, 500)}`);
      await this.record(account.id, runId, 'streaming', String(media.id), { status: signal.aborted ? 'skipped' : 'success', reason: signal.aborted ? '推流已取消或达到时限' : '推流正常结束' });
    } finally {
      clearTimeout(timeout); if (child && child.exitCode === null) child.kill('SIGKILL');
      const stopped = await client.stopStream(prepared.roomId); await this.record(account.id, runId, 'stream_stop', String(prepared.roomId), stopped);
    }
  }
}

export function removeMediaFile(storedName: string) { const path = join(mediaDirectory, storedName); if (existsSync(path)) unlinkSync(path); }
