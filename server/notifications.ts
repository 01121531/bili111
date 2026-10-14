import { createHash } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { AppDatabase, AccountRow } from './db';
import { decrypt, encrypt } from './security';

export type WinEventInput = { source?: string; actor?: string; content?: string; url?: string; occurredAt?: string };
export type CommentBackfillFailureInput = { dyid: string; author?: string; url?: string; reason?: string; attemptCount?: number };
export type RuntimeEvent = { type: 'wins_detected'; events: WinEventInput[] } | { type: 'account_invalid'; reason?: string } | { type: 'account_valid' };
export type EmailConfig = {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  username: string;
  password?: string;
  recipient: string;
  notifyWins: boolean;
  notifyInvalid: boolean;
  notifyRecovery: boolean;
  invalidReminderHours: number;
};

type MailContent = { subject: string; text: string; html: string };
type TransportFactory = (options: Record<string, unknown>) => { sendMail(options: Record<string, unknown>): Promise<unknown>; close?: () => void };

const defaults: EmailConfig = {
  enabled: false, smtpHost: 'smtp.qq.com', smtpPort: 465, secure: true, username: '', recipient: '',
  notifyWins: true, notifyInvalid: true, notifyRecovery: true, invalidReminderHours: 24
};
const sourceNames: Record<string, string> = { at: '@ 提醒', reply: '回复', message: '私信' };

function bool(value: unknown, fallback: boolean) { return typeof value === 'boolean' ? value : fallback; }
function text(value: unknown, fallback = '', max = 500) { return typeof value === 'string' ? value.trim().slice(0, max) : fallback; }
function number(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback; }
function normalize(input: Record<string, unknown>, previous: EmailConfig = defaults): EmailConfig {
  return {
    ...previous,
    enabled: bool(input.enabled, previous.enabled), smtpHost: text(input.smtpHost, previous.smtpHost, 200), smtpPort: number(input.smtpPort, previous.smtpPort, 1, 65535), secure: bool(input.secure, previous.secure),
    username: text(input.username, previous.username, 320), recipient: text(input.recipient, previous.recipient, 1000),
    notifyWins: bool(input.notifyWins, previous.notifyWins), notifyInvalid: bool(input.notifyInvalid, previous.notifyInvalid), notifyRecovery: bool(input.notifyRecovery, previous.notifyRecovery),
    invalidReminderHours: number(input.invalidReminderHours, previous.invalidReminderHours, 1, 168)
  };
}

export function escapeHtml(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function safeBiliUrl(value: unknown) {
  try { const url = new URL(String(value || '')); return url.protocol === 'https:' && (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')) ? url.toString() : ''; }
  catch { return ''; }
}
function displayTime(value: string | number | Date = new Date()) {
  const date = new Date(value); const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(safe);
}
function accountLabel(account: AccountRow) { return account.note || account.name || `账号 ${account.id}`; }
function layout(title: string, lead: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f3f6fa;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(lead)}</div><div style="max-width:640px;margin:0 auto;padding:28px 14px"><div style="background:#ffffff;border:1px solid #dfe6ef;border-radius:8px;overflow:hidden"><div style="padding:22px 24px;background:#111827;color:#ffffff"><div style="font-size:12px;color:#72e5e4;margin-bottom:7px">B 站动态抽奖控制台</div><h1 style="font-size:21px;line-height:1.4;margin:0">${escapeHtml(title)}</h1></div><div style="padding:24px">${body}</div></div><p style="margin:14px 4px 0;color:#7b8798;font-size:12px;line-height:1.6">此邮件由你的自部署服务自动发送。请勿向任何人泄露验证码、密码或支付凭据。</p></div></body></html>`;
}
function summaryRows(account: AccountRow, detectedAt: string) {
  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 20px"><tr><td style="padding:8px 0;color:#7b8798;font-size:13px">账号</td><td style="padding:8px 0;text-align:right;font-weight:600">${escapeHtml(accountLabel(account))}</td></tr><tr><td style="padding:8px 0;color:#7b8798;font-size:13px;border-top:1px solid #edf1f5">UID</td><td style="padding:8px 0;text-align:right;border-top:1px solid #edf1f5">${escapeHtml(account.uid || '未识别')}</td></tr><tr><td style="padding:8px 0;color:#7b8798;font-size:13px;border-top:1px solid #edf1f5">检测时间</td><td style="padding:8px 0;text-align:right;border-top:1px solid #edf1f5">${escapeHtml(displayTime(detectedAt))}</td></tr></table>`;
}

export function buildWinEmail(account: AccountRow, events: WinEventInput[], detectedAt = new Date().toISOString()): MailContent {
  const label = accountLabel(account); const subject = `[B站抽奖] 账号“${label}”疑似中奖（${events.length} 条）`;
  const cards = events.map(event => {
    const url = safeBiliUrl(event.url); const content = text(event.content, '无内容', 2000); const actor = text(event.actor, '未知用户', 160); const occurred = displayTime(event.occurredAt || detectedAt);
    return `<div style="border:1px solid #e3e9f0;border-radius:7px;padding:16px;margin:0 0 12px"><div style="margin-bottom:9px"><span style="display:inline-block;padding:3px 8px;border-radius:4px;background:#e8fafa;color:#087b7a;font-size:12px">${escapeHtml(sourceNames[event.source || ''] || event.source || '消息')}</span><span style="float:right;color:#8792a2;font-size:12px">${escapeHtml(occurred)}</span></div><div style="font-weight:600;margin-bottom:8px">${escapeHtml(actor)}</div><div style="white-space:pre-wrap;line-height:1.7;color:#445064;font-size:14px">${escapeHtml(content)}</div>${url ? `<a href="${escapeHtml(url)}" style="display:inline-block;margin-top:13px;color:#087b7a;font-size:13px;font-weight:600">前往 B 站查看 →</a>` : ''}</div>`;
  }).join('');
  const html = layout(subject, `发现 ${events.length} 条疑似中奖消息`, `${summaryRows(account, detectedAt)}<div style="padding:12px 14px;margin-bottom:18px;background:#fff8e8;border-left:3px solid #e8a52b;color:#74551d;font-size:13px;line-height:1.7">系统仅根据关键词判断，请进入 B 站核对活动主办方身份和领奖要求。</div>${cards}`);
  const lines = events.map((event, index) => `${index + 1}. ${sourceNames[event.source || ''] || event.source || '消息'} | ${text(event.actor, '未知用户', 160)} | ${displayTime(event.occurredAt || detectedAt)}\n${text(event.content, '无内容', 2000)}${safeBiliUrl(event.url) ? `\n${safeBiliUrl(event.url)}` : ''}`).join('\n\n');
  return { subject, html, text: `${subject}\n账号：${label}\nUID：${account.uid || '未识别'}\n检测时间：${displayTime(detectedAt)}\n\n${lines}\n\n请核对主办方身份，不要泄露验证码、密码或支付凭据。` };
}

function buildStatusEmail(account: AccountRow, type: 'account_invalid' | 'account_recovered', reason = '', detectedAt = new Date().toISOString()): MailContent {
  const recovered = type === 'account_recovered'; const label = accountLabel(account);
  const subject = recovered ? `[B站抽奖] 账号“${label}”登录状态已恢复` : `[B站抽奖] 账号“${label}”登录已失效`;
  const accent = recovered ? '#14805e' : '#b4233c'; const background = recovered ? '#eaf8f2' : '#fff0f2';
  const message = recovered ? '账号 Cookie 已重新验证成功，自动抽奖和中奖检测任务可以继续运行。' : '账号无法通过 B 站登录验证，请尽快在控制台重新扫码登录或更新 Cookie。';
  const html = layout(subject, message, `${summaryRows(account, detectedAt)}<div style="padding:16px;border-radius:7px;background:${background};color:${accent};font-size:14px;line-height:1.8"><strong>${escapeHtml(recovered ? '状态已恢复' : '需要处理')}</strong><br>${escapeHtml(message)}${reason ? `<br><span style="font-size:12px">原因：${escapeHtml(text(reason, '', 500))}</span>` : ''}</div>`);
  return { subject, html, text: `${subject}\n账号：${label}\nUID：${account.uid || '未识别'}\n时间：${displayTime(detectedAt)}\n${message}${reason ? `\n原因：${text(reason, '', 500)}` : ''}` };
}

export function buildCommentBackfillFailureEmail(account: AccountRow, failures: CommentBackfillFailureInput[], detectedAt = new Date().toISOString()): MailContent {
  const label = accountLabel(account); const subject = `[B站抽奖] 账号“${label}”补充评论失败（${failures.length} 条）`;
  const cards = failures.map(item => {
    const attempt = Math.min(3, Math.max(1, Number(item.attemptCount) || 1)); const final = attempt >= 3; const url = safeBiliUrl(item.url);
    return `<div style="border:1px solid #e3e9f0;border-radius:7px;padding:16px;margin:0 0 12px"><div style="font-weight:600;margin-bottom:7px">${escapeHtml(item.author || `动态 ${item.dyid}`)}</div><div style="font-size:13px;color:#445064;line-height:1.7">动态 ID：${escapeHtml(item.dyid)}<br>失败原因：${escapeHtml(text(item.reason, '未知错误', 500))}<br>尝试次数：${attempt}/3<br>后续处理：${escapeHtml(final ? '已达到重试上限，需要人工检查' : '将在至少 24 小时后自动重试')}</div>${url ? `<a href="${escapeHtml(url)}" style="display:inline-block;margin-top:12px;color:#087b7a;font-size:13px;font-weight:600">前往 B 站查看 →</a>` : ''}</div>`;
  }).join('');
  const html = layout(subject, `本次有 ${failures.length} 条补充评论未成功`, `${summaryRows(account, detectedAt)}<div style="padding:12px 14px;margin-bottom:18px;background:#fff0f2;border-left:3px solid #b4233c;color:#7b2032;font-size:13px;line-height:1.7">系统会保留已成功的评论。未达到 3 次上限的记录将在至少 24 小时后重试。</div>${cards}`);
  const lines = failures.map((item, index) => { const attempt = Math.min(3, Math.max(1, Number(item.attemptCount) || 1)); return `${index + 1}. ${item.author || `动态 ${item.dyid}`}\n动态 ID：${item.dyid}\n原因：${text(item.reason, '未知错误', 500)}\n尝试：${attempt}/3\n${attempt >= 3 ? '已达到重试上限，需要人工检查' : '至少 24 小时后自动重试'}${safeBiliUrl(item.url) ? `\n${safeBiliUrl(item.url)}` : ''}`; }).join('\n\n');
  return { subject, html, text: `${subject}\n账号：${label}\nUID：${account.uid || '未识别'}\n时间：${displayTime(detectedAt)}\n\n${lines}` };
}

function publicConfig(config: EmailConfig) { const { password, ...safe } = config; return { ...safe, passwordConfigured: Boolean(password) }; }

function splitRecipients(value: string) {
  return value.split(/[;,]/).map(item => item.trim()).filter(Boolean);
}

function validRecipientList(value: string) {
  const recipients = splitRecipients(value);
  return recipients.length > 0 && recipients.length <= 20 && recipients.every(item => item.length <= 320 && /^\S+@\S+\.\S+$/.test(item));
}

export class EmailNotificationService {
  constructor(private db: AppDatabase, private transportFactory: TransportFactory = options => createTransport(options as any) as any) {}

  private read(): EmailConfig {
    const raw = this.db.getSetting('email_notification_config'); if (!raw) return { ...defaults };
    try { const parsed = JSON.parse(raw) as Record<string, unknown>; const config = normalize(parsed); if (typeof parsed.passwordEncrypted === 'string') { try { config.password = decrypt(parsed.passwordEncrypted); } catch { config.password = undefined; } } return config; }
    catch { return { ...defaults }; }
  }
  getPublic() { return publicConfig(this.read()); }
  getAccountNotification(accountId: number) {
    const account = this.db.getAccount(accountId);
    if (!account) throw new Error('账号不存在');
    const globalRecipient = this.read().recipient;
    let configured = '';
    try {
      const value = this.db.getConfig(accountId) as Record<string, any>;
      configured = typeof value.notifications?.recipient === 'string' ? value.notifications.recipient.trim() : '';
    } catch { configured = ''; }
    return { recipient: configured || globalRecipient, configuredRecipient: configured, inherited: !configured, globalRecipient };
  }
  saveAccountNotification(accountId: number, input: Record<string, unknown>) {
    if (!this.db.getAccount(accountId)) throw new Error('账号不存在');
    const recipient = typeof input.recipient === 'string' ? input.recipient.trim().slice(0, 1000) : '';
    if (recipient && !validRecipientList(recipient)) throw new Error('账号收件邮箱格式不正确');
    let current: Record<string, any> = {};
    try { current = this.db.getConfig(accountId) as Record<string, any>; } catch { current = {}; }
    const next = { ...current };
    const notifications = { ...(current.notifications || {}) };
    if (recipient) notifications.recipient = recipient;
    else delete notifications.recipient;
    if (Object.keys(notifications).length) next.notifications = notifications;
    else delete next.notifications;
    this.db.setConfig(accountId, next);
    return this.getAccountNotification(accountId);
  }
  save(input: Record<string, unknown>) {
    const current = this.read(); const next = normalize(input, current);
    if (typeof input.password === 'string' && input.password.trim()) next.password = input.password.trim();
    if (input.clearPassword === true) delete next.password;
    if (next.enabled) this.validate(next);
    const stored: Record<string, unknown> = { ...next }; delete stored.password;
    if (next.password) stored.passwordEncrypted = encrypt(next.password);
    this.db.setSetting('email_notification_config', JSON.stringify(stored));
    return publicConfig(next);
  }
  private validate(config: EmailConfig, recipient = config.recipient) {
    if (!config.smtpHost) throw new Error('请填写 SMTP 主机');
    if (!/^\S+@\S+\.\S+$/.test(config.username)) throw new Error('发件邮箱格式不正确');
    if (!validRecipientList(recipient)) throw new Error('收件邮箱格式不正确');
    if (!config.password) throw new Error('请填写 SMTP 授权码');
  }
  private sanitizeError(error: unknown, config: EmailConfig) {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [config.password, config.username]) if (secret) message = message.split(secret).join('••••••');
    return message.slice(0, 500);
  }
  private async send(eventType: string, content: MailContent, accountId?: number, runId?: number, force = false) {
    const config = this.read(); if (!force && !config.enabled) return undefined;
    const recipient = accountId ? this.getAccountNotification(accountId).recipient : config.recipient;
    this.validate(config, recipient);
    const notificationId = this.db.addNotification({ accountId, runId, eventType, title: content.subject, content: content.text });
    const transport = this.transportFactory({ host: config.smtpHost, port: config.smtpPort, secure: config.secure, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, auth: { user: config.username, pass: config.password } });
    let lastError = '';
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await transport.sendMail({ from: `"B站抽奖助手" <${config.username}>`, to: recipient, subject: content.subject, text: content.text, html: content.html });
          this.db.updateNotification(notificationId, 'success', attempt); return { ok: true, notificationId };
        } catch (error) { lastError = this.sanitizeError(error, config); if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500)); }
      }
      this.db.updateNotification(notificationId, 'failed', 3, lastError); return { ok: false, notificationId, error: lastError };
    } finally { transport.close?.(); }
  }
  async sendTest(accountId?: number) {
    const config = this.read();
    const recipient = accountId ? this.getAccountNotification(accountId).recipient : config.recipient;
    this.validate(config, recipient);
    const subject = '[B站抽奖] 邮件通知测试成功'; const now = displayTime();
    return this.send('email_test', { subject, text: `${subject}\n发送时间：${now}\nSMTP 配置可正常使用。`, html: layout(subject, 'SMTP 配置可正常使用', `<div style="padding:16px;border-radius:7px;background:#eaf8f2;color:#14805e;line-height:1.8"><strong>连接与发送均正常</strong><br>发送时间：${escapeHtml(now)}</div>`) }, accountId, undefined, true);
  }
  private within(record: { created_at: string } | undefined, milliseconds: number) { return Boolean(record && Date.now() - new Date(record.created_at).getTime() < milliseconds); }
  async notifyInvalid(account: AccountRow, reason: string, runId?: number) {
    const config = this.read(); if (!config.enabled || !config.notifyInvalid) return undefined;
    const latest = this.db.latestNotification(account.id, 'account_invalid');
    if (latest?.status === 'success' && this.within(latest, config.invalidReminderHours * 3600000)) return undefined;
    if (latest?.status !== 'success' && this.within(latest, 30 * 60000)) return undefined;
    return this.send('account_invalid', buildStatusEmail(account, 'account_invalid', reason), account.id, runId);
  }
  async notifyRecovery(account: AccountRow, runId?: number) { const config = this.read(); return config.enabled && config.notifyRecovery ? this.send('account_recovered', buildStatusEmail(account, 'account_recovered'), account.id, runId) : undefined; }
  async notifyWins(account: AccountRow, events: WinEventInput[], runId?: number) { const config = this.read(); return config.enabled && config.notifyWins && events.length ? this.send('win_detected', buildWinEmail(account, events), account.id, runId) : undefined; }
  async notifyCommentBackfillFailures(account: AccountRow, failures: CommentBackfillFailureInput[], runId?: number) {
    const config = this.read();
    return config.enabled && failures.length ? this.send('comment_backfill_failed', buildCommentBackfillFailureEmail(account, failures), account.id, runId) : undefined;
  }

  async handleRuntimeEvents(accountId: number, runId: number, events: RuntimeEvent[], log?: (level: string, message: string) => void) {
    for (const event of events) {
      const account = this.db.getAccount(accountId); if (!account) continue;
      if (event.type === 'account_invalid') {
        this.db.updateAccount(accountId, { cookieStatus: 'invalid' });
        const result = await this.notifyInvalid(this.db.getAccount(accountId)!, event.reason || 'B站登录验证失败', runId);
        if (result) log?.(result.ok ? 'info' : 'error', result.ok ? '账号失效邮件发送成功' : `账号失效邮件发送失败：${result.error}`);
      } else if (event.type === 'account_valid') {
        const wasInvalid = account.cookie_status === 'invalid'; this.db.updateAccount(accountId, { cookieStatus: 'valid' });
        if (wasInvalid) { const result = await this.notifyRecovery(this.db.getAccount(accountId)!, runId); if (result) log?.(result.ok ? 'info' : 'error', result.ok ? '账号恢复邮件发送成功' : `账号恢复邮件发送失败：${result.error}`); }
      } else if (event.type === 'wins_detected') {
        const fresh: WinEventInput[] = [];
        for (const item of event.events || []) {
          const normalized = { source: text(item.source, 'message', 30), actor: text(item.actor, '未知用户', 160), content: text(item.content, '', 4000), url: safeBiliUrl(item.url), occurredAt: text(item.occurredAt, new Date().toISOString(), 60) };
          const eventKey = createHash('sha256').update([accountId, normalized.source, normalized.actor, normalized.content, normalized.url, normalized.occurredAt].join('|')).digest('hex');
          if (this.db.addWinEvent({ accountId, ...normalized, eventKey })) fresh.push(normalized);
        }
        if (fresh.length) { const result = await this.notifyWins(account, fresh, runId); if (result) log?.(result.ok ? 'info' : 'error', result.ok ? `中奖邮件发送成功（${fresh.length} 条）` : `中奖邮件发送失败：${result.error}`); }
      }
    }
  }
}

export { defaults as defaultEmailConfig, publicConfig };
