import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppDatabase } from './db';

const UPDATE_SCRIPT = '/usr/local/sbin/lottery-web-update';

type UpdateState = {
  status?: 'idle' | 'checking' | 'running' | 'success' | 'failed';
  jobId?: string;
  currentCommit?: string;
  deployedCommit?: string;
  remoteCommit?: string;
  remoteMessage?: string;
  remoteDate?: string;
  checkedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  rollback?: boolean;
  updateSource?: 'upload';
};

type PackageMetadata = { commit: string; sha256: string; size: number; createdAt: string };

export class UpdateService {
  private statePath: string;
  private logPath: string;
  private packagePath: string;
  private packageMetadataPath: string;
  private running = false;

  constructor(private db: AppDatabase, options: { dataDir?: string } = {}) {
    const dataDir = options.dataDir || dirname(process.env.DATABASE_PATH || join(process.cwd(), 'data', 'lottery.db'));
    this.statePath = process.env.UPDATE_STATE_PATH || join(dataDir, 'update-state.json');
    this.logPath = process.env.UPDATE_LOG_PATH || join(dataDir, 'update.log');
    const packageDir = process.env.UPDATE_PACKAGE_DIR || join(dataDir, 'update-packages');
    this.packagePath = join(packageDir, 'pending.tar.gz');
    this.packageMetadataPath = join(packageDir, 'pending.json');
    mkdirSync(dirname(this.statePath), { recursive: true });
    mkdirSync(packageDir, { recursive: true });
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

  private pendingPackage() {
    if (!existsSync(this.packagePath) || !existsSync(this.packageMetadataPath)) return null;
    try {
      const metadata = JSON.parse(readFileSync(this.packageMetadataPath, 'utf8')) as PackageMetadata;
      if (!/^[a-f0-9]{40}$/i.test(metadata.commit) || !/^[a-f0-9]{64}$/i.test(metadata.sha256) || !Number.isSafeInteger(metadata.size) || metadata.size < 512) return null;
      return metadata;
    } catch { return null; }
  }

  uploadPackage(body: Buffer, commitRaw: unknown) {
    const commit = String(commitRaw || '').trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('发布包文件名必须包含完整的 40 位提交号');
    if (!Buffer.isBuffer(body) || body.length < 512) throw new Error('发布包为空或格式无效');
    if (body[0] !== 0x1f || body[1] !== 0x8b) throw new Error('发布包不是有效的 gzip 文件');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const token = randomBytes(8).toString('hex');
    const packageTemp = `${this.packagePath}.${token}.tmp`;
    const metadataTemp = `${this.packageMetadataPath}.${token}.tmp`;
    const metadata: PackageMetadata = { commit, sha256, size: body.length, createdAt: new Date().toISOString() };
    writeFileSync(packageTemp, body);
    writeFileSync(metadataTemp, JSON.stringify(metadata, null, 2), 'utf8');
    renameSync(packageTemp, this.packagePath);
    renameSync(metadataTemp, this.packageMetadataPath);
    this.writeState({ status: 'idle', remoteCommit: commit, remoteMessage: '本地上传发布包', checkedAt: new Date().toISOString(), error: undefined, rollback: false, updateSource: 'upload' });
    return { ok: true, commit, sha256, size: body.length, status: this.status() };
  }

  async check() {
    const pending = this.pendingPackage();
    if (!pending) throw new Error('请先上传本地发布包');
    const content = readFileSync(this.packagePath);
    if (content.length !== pending.size) throw new Error('发布包大小校验失败，请重新上传');
    if (createHash('sha256').update(content).digest('hex') !== pending.sha256.toLowerCase()) throw new Error('发布包 SHA-256 校验失败，请重新上传');
    const current = this.readState().deployedCommit || this.currentCommit();
    this.writeState({ status: 'idle', currentCommit: current || undefined, remoteCommit: pending.commit, remoteMessage: '本地上传发布包', checkedAt: new Date().toISOString(), error: undefined, rollback: false, updateSource: 'upload' });
    return this.status();
  }

  status() {
    const state = this.readState();
    const current = state.deployedCommit || this.currentCommit();
    const pending = this.pendingPackage();
    return {
      currentCommit: current || state.currentCommit || null,
      remoteCommit: pending?.commit || null,
      remoteMessage: pending ? '本地上传发布包' : null,
      remoteDate: pending?.createdAt || null,
      version: this.version(),
      hasUpdate: Boolean(current && pending?.commit && current !== pending.commit),
      lastCheckAt: state.checkedAt || null,
      status: state.status || 'idle',
      jobId: state.jobId || null,
      startedAt: state.startedAt || null,
      finishedAt: state.finishedAt || null,
      error: state.error || null,
      rollback: Boolean(state.rollback),
      updateSource: pending ? 'upload' : null,
      packageReady: Boolean(pending),
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
    const pending = this.pendingPackage();
    if (!pending) throw new Error('请先上传并校验本地发布包');
    const current = state.deployedCommit || this.currentCommit();
    if (!current) throw new Error('无法识别当前版本');
    if (current === pending.commit) throw new Error('当前已经是该发布包版本');
    const jobId = randomBytes(10).toString('hex');
    this.running = true;
    this.writeState({ status: 'running', jobId, currentCommit: current, startedAt: new Date().toISOString(), finishedAt: undefined, error: undefined, rollback: false });
    const child = spawn('sudo', ['-n', UPDATE_SCRIPT], { cwd: process.cwd(), detached: true, stdio: 'ignore', env: { ...process.env, LOTTERY_UPDATE_JOB_ID: jobId } });
    child.on('error', error => { this.writeState({ status: 'failed', finishedAt: new Date().toISOString(), error: String(error) }); this.running = false; });
    child.on('exit', (code, signal) => {
      this.running = false;
      if (code !== 0) this.writeState({ status: 'failed', finishedAt: new Date().toISOString(), error: `更新启动器异常退出（${signal || code || 'unknown'}）` });
    });
    child.unref();
    return { jobId };
  }
}
