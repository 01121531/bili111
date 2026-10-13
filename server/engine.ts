import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppDatabase, AccountRow } from './db';
import { decrypt } from './security';
import { mergedConfig, runtimeConfig, stringifyRuntimeConfig } from './config';
import { AiService } from './ai';
import { EmailNotificationService, RuntimeEvent } from './notifications';
import { parseDrawTime } from './lottery-enricher';

export type EngineResult = { code: number; discovered: number; candidates: number; attempted: number; success: number; partial: number; failed: number; errors: number };

function cleanRuntimeText(value: unknown, limit = 1000) {
  return value === null || value === undefined ? null : String(value).replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••').slice(0, limit);
}

export class EngineRunner {
  processes = new Map<number, ChildProcessWithoutNullStreams>();
  constructor(private db: AppDatabase, private emit: (event: object) => void, private ai: AiService, private notifications: EmailNotificationService) {}

  run(jobId: number, runId: number, account: AccountRow, mode: string, config: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<EngineResult> {
    const cliMode = mode === 'discover' ? 'start' : mode === 'clear_preview' ? 'clear' : mode;
    const runtimePath = join(process.cwd(), 'my_config.js');
    const aiConfig = this.ai.resolve(account.id);
    let inheritedConfig: Record<string, unknown> = {};
    try { inheritedConfig = JSON.parse(this.db.getSetting('global_config') || '{}'); } catch { inheritedConfig = {}; }
    const effectiveConfig = mergedConfig(config, inheritedConfig);
    const cleanupDays = Math.max(1, Math.min(3650, Math.round(Number(effectiveConfig.clear_max_day) || 30)));
    const cleanupProtection = this.db.cleanupProtection(account.id, Math.floor(Date.now() / 1000) - cleanupDays * 86400);
    writeFileSync(runtimePath, `module.exports = ${stringifyRuntimeConfig(runtimeConfig(account.id, config, aiConfig, inheritedConfig))};\n`, 'utf8');
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
    const commentLimit = Math.min(100, Math.max(1, Number(options.limit) || 20));
    const commentItems = mode === 'comment_backfill' ? this.db.listCommentBackfillCandidates(account.id, commentLimit) : [];
    const child = spawn(process.execPath, [join(process.cwd(), 'main.js'), cliMode], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COOKIE: decrypt(account.cookie),
        NUMBER: String(account.id),
        LOTTERY_ACCOUNT_SCOPE: String(account.id),
        LOTTERY_LOG_LEVEL: '3',
        NOT_GO_LOTTERY: mode === 'discover' ? '1' : '',
        CLEAR: mode === 'clear' || mode === 'clear_preview' ? '1' : '',
        CLEAR_PREVIEW: mode === 'clear_preview' ? '1' : '',
        WEB_MANAGED_CLEAR: '1',
        CLEANUP_ACTIVE_UP_UIDS: JSON.stringify(cleanupProtection.uids),
        CLEANUP_UNRESOLVED_ACTIVE: cleanupProtection.unresolved ? '1' : '',
        COMMENT_BACKFILL_ITEMS: mode === 'comment_backfill' ? JSON.stringify(commentItems.map(item => ({ dyid: String(item.dyid), author: String(item.author || ''), description: String(item.description || ''), url: String(item.url || '') }))) : '',
        WEB_MANAGED_NOTIFICATIONS: '1',
        ...aiEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.processes.set(jobId, child);
    let processErrors = 0; let stdoutBuffer = ''; let stderrBuffer = ''; const runtimeEvents: RuntimeEvent[] = []; let cleanupSummary: Record<string, any> | null = null;
    const discoveredIds = new Set<string>(); const candidateIds = new Set<string>(); const attemptedIds = new Set<string>(); const participatedIds = new Set<string>(); const partialIds = new Set<string>(); const failedIds = new Set<string>();
    const consumeLine = (raw: string, level: string) => {
      const message = raw.trim(); if (!message) return;
      if (message.startsWith('[LOTTERY_WEB_EVENT]')) {
        try {
          const event = JSON.parse(message.slice('[LOTTERY_WEB_EVENT]'.length)) as { type: string; lottery?: Record<string, unknown>; participation?: Record<string, any>; cleanup?: Record<string, any>; [key: string]: unknown };
          if (event.type === 'lottery' && event.lottery?.dyid) {
            const dyid = String(event.lottery.dyid);
            const description = String(event.lottery.description || ''); const sourceCreatedAt = Number(event.lottery.sourceCreatedAt || 0) || null;
            const drawTime = Number(event.lottery.drawTime || 0) || parseDrawTime(description, sourceCreatedAt);
            discoveredIds.add(dyid);
            const lotteryStatus = String(event.lottery.status || '');
            if (['candidate', 'participated', 'partial', 'failed'].includes(lotteryStatus) || ['已参与或已转发', '当前账号已参与或已转发'].includes(String(event.lottery.resultReason || ''))) candidateIds.add(dyid);
            if (['participated', 'partial', 'failed'].includes(lotteryStatus)) attemptedIds.add(dyid);
            if (lotteryStatus === 'participated') { participatedIds.add(dyid); failedIds.delete(dyid); }
            if (lotteryStatus === 'partial' && !participatedIds.has(dyid)) { partialIds.add(dyid); failedIds.delete(dyid); }
            if (lotteryStatus === 'failed' && !participatedIds.has(dyid)) failedIds.add(dyid);
            this.db.upsertLottery(account.id, {
              dyid, source: String(event.lottery.source || '') || undefined, author: String(event.lottery.author || '') || undefined,
              authorUid: event.lottery.authorUid === undefined ? undefined : String(event.lottery.authorUid || '') || null,
              description: description || undefined, drawTime, drawTimeSource: event.lottery.drawTimeSource === undefined ? undefined : String(event.lottery.drawTimeSource || '') || null,
              official: event.lottery.official === undefined ? undefined : Boolean(event.lottery.official), status: String(event.lottery.status || '') || undefined,
              resultReason: event.lottery.resultReason === undefined ? undefined : String(event.lottery.resultReason || ''), url: String(event.lottery.url || '') || undefined,
              sourceCreatedAt, enrichmentStatus: event.lottery.description ? 'complete' : undefined, runId
            });
          } else if (event.type === 'lottery_participation' && event.participation?.dyid) {
            const participation = event.participation; const dyid = String(participation.dyid);
            const cleanText = cleanRuntimeText;
            const cleanAction = (value: any = {}) => ({ plannedText: cleanText(value.plannedText), actualText: cleanText(value.actualText), source: cleanText(value.source, 40) || 'none', status: cleanText(value.status, 40) || 'not_required', code: Number(value.code) || 0, reason: cleanText(value.reason, 500) || undefined });
            const overallStatus = ['success', 'partial', 'failed'].includes(String(participation.overallStatus)) ? String(participation.overallStatus) : 'failed';
            const record = this.db.upsertParticipation(account.id, runId, { dyid, overallStatus, resultCode: Number(participation.code) || 0, resultReason: cleanText(participation.reason, 500) || undefined, comment: cleanAction(participation.comment), follow: cleanAction(participation.follow), like: cleanAction(participation.like), relay: cleanAction(participation.relay), startedAt: cleanText(participation.startedAt, 50) || undefined, finishedAt: cleanText(participation.finishedAt, 50) || undefined });
            candidateIds.add(dyid); attemptedIds.add(dyid);
            if (overallStatus === 'success') { participatedIds.add(dyid); partialIds.delete(dyid); failedIds.delete(dyid); }
            if (overallStatus === 'partial' && !participatedIds.has(dyid)) { partialIds.add(dyid); failedIds.delete(dyid); }
            if (overallStatus === 'failed' && !participatedIds.has(dyid) && !partialIds.has(dyid)) failedIds.add(dyid);
            this.emit({ type: 'participation', payload: record });
          } else if (event.type === 'cleanup_record' && event.cleanup?.targetId) {
            const record = this.db.addCleanupRecord(runId, account.id, {
              action: String(event.cleanup.action || 'skip').slice(0, 40), targetId: String(event.cleanup.targetId).slice(0, 80),
              relatedUid: event.cleanup.relatedUid ? String(event.cleanup.relatedUid).slice(0, 40) : null,
              dynamicCreatedAt: Number(event.cleanup.dynamicCreatedAt) || null, inferredExpiredAt: Number(event.cleanup.inferredExpiredAt) || null,
              status: String(event.cleanup.status || 'skipped').slice(0, 40), reason: cleanRuntimeText(event.cleanup.reason, 500)
            });
            this.emit({ type: 'cleanup', payload: record });
          } else if (event.type === 'cleanup_summary' && event.cleanup) {
            cleanupSummary = event.cleanup;
            this.db.upsertCleanupSummary(runId, account.id, cleanupSummary);
          } else runtimeEvents.push(event as unknown as RuntimeEvent);
        }
        catch { processErrors += 1; }
        return;
      }
      const safe = message.replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••');
      if (level === 'error' || /\[(?:Error|错误)\]/i.test(safe)) processErrors += 1;
      const context = safe.match(/\[帐号\d+ ([^\]]+)/)?.[1] || 'engine';
      const log = this.db.addLog(runId, account.id, level, context, safe);
      this.emit({ type: 'log', payload: log });
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
      const cleanup = cleanupSummary as Record<string, any> | null;
      resolve({
        code: code ?? 1,
        discovered: cleanup ? Number(cleanup.scannedCount) || 0 : discoveredIds.size,
        candidates: cleanup ? Number(cleanup.expiredCount) || 0 : candidateIds.size,
        attempted: cleanup ? (Number(cleanup.deleteCandidateCount) || 0) + (Number(cleanup.unfollowCandidateCount) || 0) : attemptedIds.size,
        success: cleanup ? (Number(cleanup.deleteSuccessCount) || 0) + (Number(cleanup.unfollowSuccessCount) || 0) : participatedIds.size,
        partial: partialIds.size,
        failed: cleanup ? (Number(cleanup.deleteFailedCount) || 0) + (Number(cleanup.unfollowFailedCount) || 0) : failedIds.size,
        errors: processErrors
      });
    }));
  }

  cancel(jobId: number) { const process = this.processes.get(jobId); if (process) { process.kill('SIGTERM'); return true; } return false; }
}
