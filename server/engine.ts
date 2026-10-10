import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase, AccountRow } from './db';
import { decrypt } from './security';
import { runtimeConfig } from './config';
import { AiService } from './ai';

export type EngineResult = { code: number; discovered: number; attempted: number; success: number; errors: number };

export class EngineRunner {
  processes = new Map<number, ChildProcessWithoutNullStreams>();
  constructor(private db: AppDatabase, private emit: (event: object) => void, private ai: AiService) {}

  run(jobId: number, runId: number, account: AccountRow, mode: string, config: Record<string, unknown>): Promise<EngineResult> {
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
    const child = spawn(process.execPath, [join(process.cwd(), 'main.js'), mode], {
      cwd: process.cwd(),
      env: { ...process.env, COOKIE: decrypt(account.cookie), NUMBER: String(account.id), LOTTERY_LOG_LEVEL: '3', ...aiEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.processes.set(jobId, child);
    let discovered = 0; let attempted = 0; let success = 0; let errors = 0;
    const consume = (chunk: Buffer, level: string) => {
      for (const raw of chunk.toString().split(/\r?\n/)) {
        const message = raw.trim(); if (!message) continue;
        const safe = message.replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••');
        if (/抽奖信息|动态/.test(safe)) discovered += /动态/.test(safe) ? 1 : 0;
        if (/成功/.test(safe)) success += 1;
        if (/失败|Error|错误/.test(safe)) errors += 1;
        if (/转发|评论|点赞|关注|预约/.test(safe)) attempted += 1;
        const context = safe.match(/\[帐号\d+ ([^\]]+)/)?.[1] || 'engine';
        const log = this.db.addLog(runId, account.id, level, context, safe);
        this.emit({ type: 'log', payload: log });
        const dyid = safe.match(/t\.bilibili\.com\/(\d{8,})/)?.[1];
        if (dyid) this.db.addLottery(account.id, dyid, mode);
      }
    };
    child.stdout.on('data', chunk => consume(chunk, 'info'));
    child.stderr.on('data', chunk => consume(chunk, 'error'));
    return new Promise(resolve => child.on('close', code => { this.processes.delete(jobId); resolve({ code: code ?? 1, discovered, attempted, success, errors }); }));
  }

  cancel(jobId: number) { const process = this.processes.get(jobId); if (process) { process.kill('SIGTERM'); return true; } return false; }
}
