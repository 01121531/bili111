import { useState } from 'react';
import { KeyRound, Save } from 'lucide-react';
import { AnyObject, ErrorNote, PageHeader, Panel, api } from '../core';

export function PasswordPage({ onNotify }: AnyObject) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  function reset() { setCurrent(''); setNext(''); setConfirm(''); setError(''); }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next, confirmPassword: confirm }) });
      reset();
      onNotify('后台管理密码已修改');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return <>
    <PageHeader title="后台密码" description="修改登录管理控制台使用的管理员密码，新密码至少 6 个字符。" />
    <Panel title="修改密码">
      <form className="login-card password-card" onSubmit={submit}>
        <div className="login-brand"><span><KeyRound size={24} /></span><div><strong>修改管理员密码</strong><small>修改后请使用新密码重新登录</small></div></div>
        <label>当前密码<input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} placeholder="请输入当前密码" /></label>
        <label>新密码<input type="password" autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} placeholder="至少 6 个字符" /></label>
        <label>确认新密码<input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} placeholder="再次输入新密码" /></label>
        {error && <ErrorNote>{error}</ErrorNote>}
        <button className="button primary full" disabled={saving || !current || !next || !confirm}>{saving ? '正在保存' : '保存新密码'}</button>
      </form>
    </Panel>
  </>;
}
