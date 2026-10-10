import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppDatabase } from './db';

const REPOSITORY = '01121531/bili111';
const BRANCH = 'main';
const UPDATE_SCRIPT = '/usr/local/sbin/lottery-web-update';

type UpdateState = {
  status?: 'idle' | 'checking' | 'running' | 'success' | 'failed';
  jobId?: string;
  currentCommit?: string;
  remoteCommit?: string;
  remoteMessage?: string;
  remoteDate?: string;
  checkedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  rollback?: boolean;
};

export class UpdateService {
  private statePath: string;
  private logPath: string;
  private running = false;

  constructor(private db: AppDatabase) {
    const dataDir = dirname(process.env.DATABASE_PATH || join(process.cwd(), 'data', 'lottery.db'));
    this.statePath = process.env.UPDATE_STATE_PATH || join(dataDir, 'update-state.json');
    this.logPath = process.env.UPDATE_LOG_PATH || join(dataDir, 'update.log');
    mkdirSync(dirname(this.statePath), { recursive: true });
  }

  private readState(): UpdateState {
    try { return JSON.parse(readFileSync(this.statePath, 'utf8')) as UpdateState; } catch { return { status: 'idle' }; }
  }

  private writeState(next: UpdateState) {
    const state = { ...this.readState(), ...next };
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
    return state;
  }

  private currentCommit() {
    try { return execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); }
    catch { return null; }
  }

  private async remoteCommit() {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/commits/${BRANCH}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'bili111-lottery-web' }
    });
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const value = await response.json() as any;
    return { sha: String(value.sha), message: String(value.commit?.message || '').split('\n')[0], date: value.commit?.committer?.date || null };
  }

  async check() {
    const current = this.currentCommit();
    const remote = await this.remoteCommit();
    const state = this.writeState({ status: 'idle', currentCommit: current || undefined, remoteCommit: remote.sha, remoteMessage: remote.message, remoteDate: remote.date || undefined, checkedAt: new Date().toISOString(), error: undefined, rollback: false });
    this.db.setSetting('update_last_check', state.checkedAt!);
    return this.status();
  }

  status() {
    const state = this.readState();
    const current = this.currentCommit();
    return {
      repository: REPOSITORY,
      branch: BRANCH,
      currentCommit: current || state.currentCommit || null,
      remoteCommit: state.remoteCommit || null,
      remoteMessage: state.remoteMessage || null,
      remoteDate: state.remoteDate || null,
      version: this.version(),
      hasUpdate: Boolean(current && state.remoteCommit && current !== state.remoteCommit),
      lastCheckAt: state.checkedAt || this.db.getSetting('update_last_check') || null,
      status: state.status || 'idle',
      jobId: state.jobId || null,
      startedAt: state.startedAt || null,
      finishedAt: state.finishedAt || null,
      error: state.error || null,
      rollback: Boolean(state.rollback),
      updateAvailable: existsSync(UPDATE_SCRIPT)
    };
  }

  private version() {
    try {
      const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
      return String(packageJson.version || 'unknown');
    } catch { return 'unknown'; }
  }

  logs() {
    try {
      const lines = readFileSync(this.logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-500);
      return lines.map((message, index) => ({ id: index, level: /ERROR|FAIL|失败/i.test(message) ? 'error' : 'info', message }));
    } catch { return []; }
  }

  apply() {
    const state = this.readState();
    if (this.running || state.status === 'running') throw new Error('已有更新任务正在运行');
    if (!existsSync(UPDATE_SCRIPT)) throw new Error('服务器未安装固定更新脚本');
    const current = this.currentCommit();
    if (!current || !state.remoteCommit) throw new Error('请先检查更新');
    if (current === state.remoteCommit) throw new Error('当前已经是最新版本');
    const jobId = randomBytes(10).toString('hex');
    this.running = true;
    this.writeState({ status: 'running', jobId, currentCommit: current, startedAt: new Date().toISOString(), finishedAt: undefined, error: undefined, rollback: false });
    const child = spawn('sudo', ['-n', UPDATE_SCRIPT], { cwd: process.cwd(), detached: true, stdio: 'ignore', env: { ...process.env, LOTTERY_UPDATE_JOB_ID: jobId } });
    child.on('error', error => { this.writeState({ status: 'failed', finishedAt: new Date().toISOString(), error: String(error) }); this.running = false; });
    child.unref();
    return { jobId };
  }
}
