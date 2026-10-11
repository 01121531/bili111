import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase, AccountRow } from './db';
import { decrypt } from './security';
import { runtimeConfig } from './config';
import { AiService } from './ai';
import { EmailNotificationService, RuntimeEvent } from './notifications';

export type EngineResult = { code: number; discovered: number; attempted: number; success: number; errors: number };

export class EngineRunner {
  processes = new Map<number, ChildProcessWithoutNullStreams>();
  constructor(private db: AppDatabase, private emit: (event: object) => void, private ai: AiService, private notifications: EmailNotificationService) {}

  run(jobId: number, runId: number, account: AccountRow, mode: string, config: Record<string, unknown>): Promise<EngineResult> {
    const cliMode = mode === 'discover' ? 'start' : mode;
    const runtimePath = join(process.cwd(), 'my_config.js');
    const aiConfig = this.ai.resolve(account.id);
    writeFileSync(runtimePath, `module.exports = ${JSON.stringify(runtimeConfig(account.id, config, aiConfig), null, 2)};\n`, 'utf8');
    const aiEnv = {
      AI_API_KEY: aiConfig.apiKey || '',
      ENABLE_AI_JUDGE: aiConfig.apiKey && aiConfig.enableJudge ? '1' : '',
      ENABLE_AI_COMMENTS: aiConfig.apiKey && aiConfig.enableComments ? '1' : '',
      ENABLE_AI_RELAY: aiConfig.apiKey && aiConfig.enableRelay ? '1' : '',
      AI_MAX_REQUESTS_PER_RUN: String(aiConfig.maxRequestsPerRun),
      AI_FALLBACK_COMMENT: aiConfig.fallbackComment,
      AI_FALLBACK_RELAY: aiConfig.fallbackRelay,
      AI_ALLOW_EMPTY_RELAY: aiConfig.allowEmptyRelay ? '1' : '',
      AI_SENSITIVE_WORDS: JSON.stringify(aiConfig.sensitiveWords),
      NOTE: account.note || ''
    };
    const child = spawn(process.execPath, [join(process.cwd(), 'main.js'), cliMode], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COOKIE: decrypt(account.cookie),
        NUMBER: String(account.id),
        LOTTERY_LOG_LEVEL: '3',
        NOT_GO_LOTTERY: mode === 'discover' ? '1' : '',
        WEB_MANAGED_NOTIFICATIONS: '1',
        ...aiEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.processes.set(jobId, child);
    let discovered = 0; let attempted = 0; let success = 0; let errors = 0; let stdoutBuffer = ''; let stderrBuffer = ''; const runtimeEvents: RuntimeEvent[] = [];
    const consumeLine = (raw: string, level: string) => {
      const message = raw.trim(); if (!message) return;
      if (message.startsWith('[LOTTERY_WEB_EVENT]')) {
        try { runtimeEvents.push(JSON.parse(message.slice('[LOTTERY_WEB_EVENT]'.length)) as RuntimeEvent); }
        catch { errors += 1; }
        return;
      }
      const safe = message.replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••');
      if (/抽奖信息|动态/.test(safe)) discovered += /动态/.test(safe) ? 1 : 0;
      if (/成功/.test(safe)) success += 1;
      if (level === 'error' || /\[(?:Error|错误)\]/i.test(safe)) errors += 1;
      if (mode !== 'discover' && /转发|评论|点赞|关注|预约/.test(safe)) attempted += 1;
      const context = safe.match(/\[帐号\d+ ([^\]]+)/)?.[1] || 'engine';
      const log = this.db.addLog(runId, account.id, level, context, safe);
      this.emit({ type: 'log', payload: log });
      const dyid = safe.match(/t\.bilibili\.com\/(\d{8,})/)?.[1];
      if (dyid) this.db.addLottery(account.id, dyid, mode);
    };
    const consume = (chunk: Buffer, level: string) => {
      const combined = (level === 'info' ? stdoutBuffer : stderrBuffer) + chunk.toString(); const lines = combined.split(/\r?\n/); const remainder = lines.pop() || '';
      if (level === 'info') stdoutBuffer = remainder; else stderrBuffer = remainder;
      for (const line of lines) consumeLine(line, level);
    };
    child.stdout.on('data', chunk => consume(chunk, 'info'));
    child.stderr.on('data', chunk => consume(chunk, 'error'));
    return new Promise(resolve => child.on('close', code => {
      this.processes.delete(jobId);
      consumeLine(stdoutBuffer, 'info'); consumeLine(stderrBuffer, 'error');
      const notificationLog = (level: string, message: string) => { const log = this.db.addLog(runId, account.id, level, '邮件通知', message); this.emit({ type: 'log', payload: log }); };
      void this.notifications.handleRuntimeEvents(account.id, runId, runtimeEvents, notificationLog).catch(error => notificationLog('error', `通知处理失败：${error instanceof Error ? error.message : String(error)}`));
      resolve({ code: code ?? 1, discovered, attempted, success, errors });
    }));
  }

  cancel(jobId: number) { const process = this.processes.get(jobId); if (process) { process.kill('SIGTERM'); return true; } return false; }
}
