import type { ReactNode } from 'react';
import { AlertCircle, Inbox } from 'lucide-react';

export type AnyObject = Record<string, any>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

export async function api<T = AnyObject>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has('content-type') && !(init.body instanceof FormData) && !(init.body instanceof Blob)) headers.set('content-type', 'application/json');
  const response = await fetch(path, { credentials: 'include', ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('admin-session-expired'));
    throw new ApiError(data.error || '请求失败', response.status);
  }
  return data as T;
}

export const taskText: AnyObject = { start: '执行抽奖', discover: '仅发现抽奖', check: '中奖检测', clear: '开奖清理', clear_preview: '清理预览', account: '验证账号', comment_backfill: '补充历史评论', daily: 'B站有限任务', live_automation: '长运行直播任务', streaming: '自动开播' };
export const statusText: AnyObject = {
  valid: '正常', invalid: '失效', unknown: '待验证', pending: '排队中', running: '运行中', success: '已完成', failed: '失败', skipped: '已跳过', cancelled: '已取消', cancelling: '正在停止', interrupted: '已中断', completed: '此前已完成', throttled: '风控暂停',
  candidate: '候选', filtered: '未通过筛选', participated: '已参与', partial: '部分完成', not_attempted: '未尝试', not_required: '未要求', already_participated: '此前已参与', already_done: '此前已完成', challenge: '需要验证'
};
export const levelText: AnyObject = { info: '信息', warn: '警告', warning: '警告', error: '错误', debug: '调试' };
export const sourceText: AnyObject = { follow_feed: '关注动态流', uid: '指定 UID', tag: '话题', article: '专栏', article_uid: '合集专栏', api: '外部 API', txt: '文本列表', runtime: '运行记录', legacy: '历史记录' };

export function formatDate(value?: string | number | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

export function formatDuration(start?: string, end?: string) {
  if (!start) return '—';
  const milliseconds = Math.max(0, new Date(end || Date.now()).getTime() - new Date(start).getTime());
  if (milliseconds < 1000) return `${milliseconds} 毫秒`;
  if (milliseconds < 60000) return `${Math.round(milliseconds / 1000)} 秒`;
  return `${Math.floor(milliseconds / 60000)} 分 ${Math.round((milliseconds % 60000) / 1000)} 秒`;
}

export function StatusPill({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`status-pill status-${status}`}><span className="status-dot" />{children || statusText[status] || status}</span>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function Panel({ title, subtitle, actions, children, className = '' }: { title?: string; subtitle?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{(title || actions) && <div className="panel-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{actions}</div>}{children}</section>;
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return <div className="empty-state"><Inbox size={26} /><strong>{title}</strong>{description && <p>{description}</p>}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="error-note" role="alert"><AlertCircle size={17} />{children}</div>;
}

export function Pagination({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (page: number) => void }) {
  return <div className="pagination"><span>共 {total} 条</span><div><button className="button secondary compact" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button><span>第 {page} / {pages} 页</span><button className="button secondary compact" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</button></div></div>;
}
