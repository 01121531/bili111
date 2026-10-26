import { useEffect, useState } from 'react';
import { Clock3, Eye, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2, UserMinus } from 'lucide-react';
import { AnyObject, EmptyState, PageHeader, Panel, StatusPill, api, formatDate, taskText } from '../core';

type CleanupPayload = {
  scope: 'default' | 'account'; inherited: boolean; effective: AnyObject; defaults: AnyObject;
  schedule: AnyObject | null;
};
type PartitionOption = { tagid: number; name: string; count: number; selected: boolean };

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>;
}

function metric(value: AnyObject | null, key: string) { return Number(value?.[key]) || 0; }

export function CleanupPage({ accounts, onNotify }: AnyObject) {
  const [scope, setScope] = useState<'default' | 'account'>('default');
  const [accountId, setAccountId] = useState<number | null>(accounts[0]?.id || null);
  const [payload, setPayload] = useState<CleanupPayload | null>(null);
  const [draft, setDraft] = useState<AnyObject>({});
  const [schedule, setSchedule] = useState<AnyObject>({ cron: '0 3 * * *', enabled: false });
  const [busy, setBusy] = useState(false);
  const [watchedJobIds, setWatchedJobIds] = useState<number[]>([]);
  const [result, setResult] = useState<AnyObject | null>(null);
  const [recentRuns, setRecentRuns] = useState<AnyObject[]>([]);
  const [partitions, setPartitions] = useState<PartitionOption[]>([]);
  const [partitionSearch, setPartitionSearch] = useState('');
  const [partitionLoading, setPartitionLoading] = useState(false);
  const [partitionError, setPartitionError] = useState('');

  useEffect(() => { if (!accountId && accounts[0]?.id) setAccountId(Number(accounts[0].id)); }, [accounts, accountId]);
  useEffect(() => { setPartitions([]); setPartitionError(''); setPartitionSearch(''); }, [accountId]);

  async function load(targetScope = scope, id = accountId) {
    if (targetScope === 'account' && !id) { setPayload(null); return; }
    const path = targetScope === 'default' ? '/api/cleanup/config' : `/api/accounts/${id}/cleanup/config`;
    const next = await api<CleanupPayload>(path);
    setPayload(next); setDraft(next.effective); setSchedule(next.schedule || { cron: '0 3 * * *', enabled: false });
    const runs = await api<AnyObject[]>('/api/runs');
    const cleanupRuns = runs.filter(item => ['clear', 'clear_preview'].includes(item.type) && (targetScope === 'default' || Number(item.account_id) === Number(id))).slice(0, 8);
    setRecentRuns(cleanupRuns);
    setResult(cleanupRuns[0] ? await api<AnyObject>(`/api/runs/${cleanupRuns[0].id}/cleanup`) : null);
  }

  useEffect(() => { void load().catch(error => onNotify(error.message)); }, [scope, accountId]);
  useEffect(() => {
    if (!watchedJobIds.length) return;
    let stopped = false;
    const poll = async () => {
      try {
        const [jobs, runs] = await Promise.all([api<AnyObject[]>('/api/jobs'), api<AnyObject[]>('/api/runs')]);
        const watched = jobs.filter(item => watchedJobIds.includes(Number(item.id)));
        const watchedRuns = runs.filter(item => watchedJobIds.includes(Number(item.job_id)) && item.status !== 'running');
        if (watchedRuns.length) {
          const details = await Promise.all(watchedRuns.map(run => api<AnyObject>(`/api/runs/${run.id}/cleanup`)));
          const merged = details.length === 1 ? details[0] : {
            summary: details.reduce((summary, detail) => {
              const next = { ...summary };
              for (const key of ['scanned_count', 'relevant_count', 'active_count', 'expired_count', 'protected_up_count', 'delete_candidate_count', 'delete_success_count', 'delete_failed_count', 'unfollow_candidate_count', 'unfollow_success_count', 'unfollow_failed_count']) next[key] = (Number(next[key]) || 0) + (Number(detail.summary?.[key]) || 0);
              for (const key of ['partition_names', 'resolved_partitions', 'missing_partitions', 'unresolved_active_items']) next[key] = [...(next[key] || []), ...(detail.summary?.[key] || [])];
              for (const key of ['unresolved_active_count', 'author_uid_enriched_count', 'author_uid_enrichment_failed_count']) next[key] = (Number(next[key]) || 0) + (Number(detail.summary?.[key]) || 0);
              next.preview = details.every(item => Boolean(item.summary?.preview));
              next.threshold_days = detail.summary?.threshold_days || next.threshold_days;
              return next;
            }, {} as AnyObject),
            records: details.flatMap(detail => detail.records || [])
          };
          setResult(merged);
        }
        const finished = watched.length === watchedJobIds.length && watched.every(item => ['success', 'partial', 'failed', 'cancelled', 'skipped'].includes(item.status));
        if (finished) {
          setWatchedJobIds([]); setBusy(false); setRecentRuns(runs.filter(item => ['clear', 'clear_preview'].includes(item.type) && (scope === 'default' || Number(item.account_id) === Number(accountId))).slice(0, 8));
          const failed = watched.filter(item => item.status === 'failed').length;
          const partial = watched.filter(item => item.status === 'partial').length;
          const prefix = watched.length > 1 ? `${watched.length} 个账号的` : '';
          onNotify(failed
            ? `${failed} 个开奖清理任务失败，请查看明细`
            : partial
              ? `${prefix}开奖清理有 ${partial} 个任务部分完成，请查看明细`
              : `${prefix}开奖清理已完成`);
          return;
        }
      } catch (error) { if (!stopped) onNotify((error as Error).message); }
      if (!stopped) window.setTimeout(poll, 1800);
    };
    void poll();
    return () => { stopped = true; };
  }, [watchedJobIds]);

  function update(key: string, value: unknown) { setDraft(current => ({ ...current, [key]: value })); }
  function selectedPartitionNames() { return String(draft.clear_partition || '').split(/[,，]+/).map(item => item.trim()).filter(Boolean); }
  function togglePartition(name: string) {
    const selected = new Set(selectedPartitionNames());
    if (selected.has(name)) selected.delete(name); else selected.add(name);
    update('clear_partition', [...selected].join(','));
  }
  async function loadPartitions() {
    if (!accountId) { onNotify('请先选择用于读取分组的账号'); return; }
    setPartitionLoading(true); setPartitionError('');
    try {
      const response = await api<{ partitions: PartitionOption[] }>(`/api/accounts/${accountId}/cleanup/partitions`);
      setPartitions(response.partitions || []);
      if (!(response.partitions || []).length) onNotify('当前账号没有可选择的关注分组');
    } catch (error) { setPartitionError((error as Error).message); }
    finally { setPartitionLoading(false); }
  }

  async function saveConfig() {
    if (scope === 'account' && !accountId) return;
    setBusy(true);
    try {
      const path = scope === 'default' ? '/api/cleanup/config' : `/api/accounts/${accountId}/cleanup/config`;
      const next = await api<CleanupPayload>(path, { method: 'PUT', body: JSON.stringify(draft) });
      setPayload(next); setDraft(next.effective); onNotify(scope === 'default' ? '默认开奖清理规则已保存' : '账号清理规则已保存');
    } catch (error) { onNotify((error as Error).message); } finally { setBusy(false); }
  }

  async function saveSchedule() {
    if (scope === 'account' && !accountId) return;
    setBusy(true);
    try {
      if (scope === 'default') await api('/api/schedules/defaults', { method: 'PUT', body: JSON.stringify({ clear: { cron: schedule.cron, enabled: Boolean(schedule.enabled) } }) });
      else await api(`/api/accounts/${accountId}/schedules/clear`, { method: 'PUT', body: JSON.stringify({ cron: schedule.cron, enabled: Boolean(schedule.enabled) }) });
      onNotify('开奖清理定时计划已保存'); await load();
    } catch (error) { onNotify((error as Error).message); } finally { setBusy(false); }
  }

  async function resetAccount() {
    if (!accountId || !window.confirm('确定让当前账号恢复继承默认清理规则和默认定时计划吗？')) return;
    setBusy(true);
    try {
      await Promise.all([
        api(`/api/accounts/${accountId}/cleanup/config/reset`, { method: 'POST' }),
        api(`/api/accounts/${accountId}/schedules/clear/reset`, { method: 'POST' })
      ]);
      onNotify('当前账号已恢复继承默认清理设置'); await load();
    } catch (error) { onNotify((error as Error).message); } finally { setBusy(false); }
  }

  async function start(preview: boolean) {
    const allAccounts = scope === 'default';
    if (!allAccounts && !accountId) { onNotify('请选择执行账号'); return; }
    const targetText = allAccounts ? `全部 ${accounts.length} 个启用账号` : '当前账号';
    if (!preview && !window.confirm(`确定对${targetText}执行开奖清理吗？系统会重新扫描，并删除超过 ${draft.clear_max_day || 30} 天的转发动态。`)) return;
    setBusy(true); setResult(null);
    try {
      const response = allAccounts
        ? await api<AnyObject>(preview ? '/api/cleanup/preview' : '/api/cleanup/run', { method: 'POST' })
        : preview
          ? { jobs: [await api<AnyObject>(`/api/accounts/${accountId}/cleanup/preview`, { method: 'POST' }).then(value => value.job)] }
          : { jobs: [await api<AnyObject>(`/api/accounts/${accountId}/jobs`, { method: 'POST', body: JSON.stringify({ type: 'clear' }) })] };
      const ids = (response.jobs || []).map((job: AnyObject) => Number(job?.id)).filter((id: number) => Number.isInteger(id) && id > 0);
      if (!ids.length) { setBusy(false); onNotify(response.reason || '没有可执行的账号'); return; }
      setWatchedJobIds(ids); onNotify(preview ? `${allAccounts ? `全部 ${ids.length} 个账号` : '清理'}预览已加入串行队列` : `${allAccounts ? `全部 ${ids.length} 个账号` : '开奖清理'}已加入串行队列`);
    } catch (error) { setBusy(false); onNotify((error as Error).message); }
  }

  async function openRun(runId: number) { setResult(await api<AnyObject>(`/api/runs/${runId}/cleanup`)); }

  const summary = result?.summary || null;
  return <>
    <PageHeader title="开奖清理" description="按账号转发动态的发布时间推定已经开奖。预览只读，执行时会重新扫描，避免使用过期候选。" actions={<>{scope === 'account' && <button className="button secondary" onClick={resetAccount} disabled={busy || !accountId}><RotateCcw size={17} />恢复继承</button>}<button className="button primary" onClick={saveConfig} disabled={busy || !payload}><Save size={17} />保存清理规则</button></>} />
    <div className="cleanup-scope-bar"><div className="segmented"><button className={scope === 'default' ? 'active' : ''} onClick={() => setScope('default')}>默认规则</button><button className={scope === 'account' ? 'active' : ''} onClick={() => setScope('account')}>单账号规则</button></div><label>{scope === 'default' ? '读取分组账号' : '执行账号'}<select value={accountId || ''} onChange={event => setAccountId(Number(event.target.value) || null)}><option value="">选择账号</option>{accounts.map((account: AnyObject) => <option value={account.id} key={account.id}>{account.note || account.name || `账号 ${account.id}`}</option>)}</select></label>{payload && <span className={`inheritance-badge ${scope === 'default' || payload.inherited ? 'inherited' : 'override'}`}>{scope === 'default' ? '新账号默认规则' : payload.inherited ? '继承默认' : '账号独立设置'}</span>}</div>
    {!payload ? <Panel><EmptyState title={scope === 'account' && !accountId ? '请选择账号' : '正在加载清理配置'} /></Panel> : <>
      <section className="cleanup-layout">
        <Panel title="推定开奖规则" subtitle="只按当前账号转发动态的发布时间计算，不使用 AI 或官方开奖时间。">
          <div className="cleanup-form">
            <label><span>经过多少天视为已开奖</span><div className="number-control"><input type="number" min="1" max="3650" value={draft.clear_max_day ?? 30} onChange={event => update('clear_max_day', Math.max(1, Math.min(3650, Number(event.target.value) || 30)))} /><span>天</span></div><small>系统初始值为 30 天，达到当天边界即进入清理候选。</small></label>
            <div className="partition-field wide"><div className="partition-heading"><div><strong>抽奖关注分组</strong><small>按分组名称保存；每个账号执行时会用自己的 Cookie 解析同名分组，不复用其他账号的分组 ID。</small></div><button type="button" className="button secondary" onClick={loadPartitions} disabled={partitionLoading || !accountId}><RefreshCw size={17} className={partitionLoading ? 'spin' : ''} />{partitionLoading ? '正在读取' : '刷新分组'}</button></div><div className="partition-selected"><span>已选择</span>{selectedPartitionNames().length ? selectedPartitionNames().map(name => <button type="button" key={name} onClick={() => togglePartition(name)} aria-label={`移除分组 ${name}`}>{name}<span aria-hidden="true">×</span></button>) : <small>尚未选择分组</small>}</div>{partitionError && <div className="partition-error" role="alert"><span>{partitionError}</span><button type="button" onClick={loadPartitions}>重试</button></div>}{!!partitions.length && <><input aria-label="搜索关注分组" value={partitionSearch} onChange={event => setPartitionSearch(event.target.value)} placeholder="搜索分组名称" /><div className="partition-options" role="group" aria-label="可选择的关注分组">{partitions.filter(item => item.name.toLocaleLowerCase().includes(partitionSearch.trim().toLocaleLowerCase())).map(item => { const checked = selectedPartitionNames().includes(item.name); return <label key={item.tagid} className={checked ? 'selected' : ''}><input type="checkbox" checked={checked} onChange={() => togglePartition(item.name)} /><span><strong>{item.name}</strong><small>{item.count} 人</small></span></label>; })}</div></>}{!partitionLoading && !partitionError && !partitions.length && <div className="partition-empty">点击“刷新分组”读取当前账号的关注分组。读取为只读操作，不会关注、取关或创建分组。</div>}</div>
            <label className="wide"><span>清理白名单</span><textarea rows={4} value={draft.clear_white_list || ''} onChange={event => update('clear_white_list', event.target.value)} placeholder="动态 ID 或 UP 主 UID，使用逗号或换行分隔" /></label>
            <label><span>操作间隔</span><div className="number-control"><input type="number" min="0" max="600000" value={draft.clear_remove_delay ?? 8000} onChange={event => update('clear_remove_delay', Math.max(0, Math.min(600000, Number(event.target.value) || 0)))} /><span>毫秒</span></div></label>
          </div>
          <div className="cleanup-switches"><div><div><strong>删除过期转发动态</strong><p>网页任务固定只处理转发动态，不删除原创内容。</p></div><Toggle checked={Boolean(draft.clear_remove_dynamic)} onChange={value => update('clear_remove_dynamic', value)} /></div><div><div><strong>取消无进行中抽奖的关注</strong><p>仅处理抽奖关注分组；保护信息不完整时自动停止取关。</p></div><Toggle checked={Boolean(draft.clear_remove_attention)} onChange={value => update('clear_remove_attention', value)} /></div></div>
        </Panel>
        <Panel title="定时执行" subtitle="默认关闭。启用后预设每天北京时间 03:00 执行。" actions={<StatusPill status={schedule.enabled ? 'success' : 'skipped'}>{schedule.enabled ? '已启用' : '已关闭'}</StatusPill>}>
          <div className="cleanup-schedule"><div className="cleanup-schedule-toggle"><div><strong>自动开奖清理</strong><p>{scope === 'default' ? '所有继承账号使用此计划' : schedule.inherited ? '当前账号继承默认计划' : '当前账号独立计划'}</p></div><Toggle checked={Boolean(schedule.enabled)} onChange={enabled => setSchedule((value: AnyObject) => ({ ...value, enabled }))} /></div><label>Cron 表达式<input value={schedule.cron || '0 3 * * *'} onChange={event => setSchedule((value: AnyObject) => ({ ...value, cron: event.target.value }))} /><small>五段格式，时区固定为 Asia/Shanghai。</small></label><div className="cleanup-next"><Clock3 size={18} /><div><span>下次执行</span><strong>{schedule.enabled ? formatDate(schedule.next_run_at) : '定时任务已关闭'}</strong></div></div><button className="button secondary full" onClick={saveSchedule} disabled={busy}><Save size={17} />保存定时计划</button></div>
        </Panel>
      </section>
      <Panel title="预览与执行" subtitle={scope === 'default' ? '默认规则会按每个启用账号的生效配置执行；预览和执行均覆盖全部启用账号。' : '预览和执行针对上方选定账号；预览不会删除动态或取消关注，真实执行前会重新扫描。'}>
        <div className="cleanup-actions"><div><ShieldCheck size={22} /><p>扫描失败时任务立即中止，任何写操作都不会发生。关注分组读取失败时仅跳过取关。</p></div><div className="button-row"><button className="button secondary" onClick={() => start(true)} disabled={busy || (scope === 'account' && !accountId)}><Eye size={17} />{scope === 'default' ? '预览全部账号' : '预览清理结果'}</button><button className="button primary" onClick={() => start(false)} disabled={busy || (scope === 'account' && !accountId)}><Trash2 size={17} />{scope === 'default' ? '清理全部账号' : '立即执行清理'}</button></div></div>
        {busy && watchedJobIds.length > 0 && <div className="info-banner"><RefreshCw size={18} className="spin" /><div><strong>任务正在串行队列中运行</strong><p>{watchedJobIds.length > 1 ? `已提交 ${watchedJobIds.length} 个账号任务，完成后本页会汇总展示结果。` : `任务 #${watchedJobIds[0]}，完成后本页会自动展示结果。`}</p></div></div>}
      </Panel>
      {summary && <><section className="cleanup-metrics"><div><span>扫描动态</span><strong>{metric(summary, 'scanned_count')}</strong></div><div><span>推定已开奖</span><strong>{metric(summary, 'expired_count')}</strong></div><div><span>保护 UP 主</span><strong>{metric(summary, 'protected_up_count')}</strong></div><div><span>补全作者 UID</span><strong>{metric(summary, 'author_uid_enriched_count')}</strong></div></section><Panel title={summary.preview ? '预览结果' : '执行结果'} subtitle={`推定开奖阈值：${summary.threshold_days} 天${summary.unfollow_blocked_reason ? `；取关已跳过：${summary.unfollow_blocked_reason}` : ''}`}><div className="cleanup-result-details"><div><span>实际读取分组</span><strong>{(summary.resolved_partitions || []).map((item: AnyObject) => item.name).join('、') || '无'}</strong></div><div><span>缺失分组</span><strong>{(summary.missing_partitions || []).join('、') || '无'}</strong></div><div><span>UID 补全</span><strong>成功 {metric(summary, 'author_uid_enriched_count')} 条，仍失败 {metric(summary, 'author_uid_enrichment_failed_count')} 条</strong></div></div>{(summary.unresolved_active_items || []).length > 0 && <div className="warning-banner" role="alert"><strong>无法确认 UP 主 UID 的进行中记录，已安全跳过取关</strong><ul>{summary.unresolved_active_items.map((item: AnyObject) => <li key={item.dyid}>动态 {item.dyid}：{item.reason || '无法读取作者信息'}</li>)}</ul></div>}<div className="cleanup-records">{(result.records || []).map((item: AnyObject) => <div key={item.id}><span className={`cleanup-action-icon ${item.action}`} >{item.action === 'dynamic_delete' ? <Trash2 size={17} /> : item.action === 'unfollow' ? <UserMinus size={17} /> : <ShieldCheck size={17} />}</span><div><strong>{item.action === 'dynamic_delete' ? `动态 ${item.target_id}` : item.action === 'unfollow' ? `UP 主 ${item.target_id}` : item.target_id}</strong><p>{item.reason || '无补充说明'}</p><small>{item.dynamic_created_at ? `发布于 ${formatDate(item.dynamic_created_at * 1000)} · ` : ''}{item.inferred_expired_at ? `推定开奖 ${formatDate(item.inferred_expired_at * 1000)}` : ''}</small></div><StatusPill status={item.status}>{item.status === 'candidate' ? '候选' : item.status === 'success' ? '成功' : item.status === 'failed' ? '失败' : '已跳过'}</StatusPill></div>)}{!(result.records || []).length && <EmptyState title="本次没有需要处理的动态或关注" />}</div></Panel></>}
      <Panel title="最近清理任务" subtitle="预览与真实执行均保留审计记录。"><div className="responsive-table"><table><thead><tr><th>账号</th><th>任务</th><th>状态</th><th>开始时间</th><th>结果</th></tr></thead><tbody>{recentRuns.map(run => <tr key={run.id} onClick={() => openRun(run.id)} className="clickable-row"><td data-label="账号">{run.account_name || `账号 ${run.account_id}`}</td><td data-label="任务">{taskText[run.type] || run.type}</td><td data-label="状态"><StatusPill status={run.status} /></td><td data-label="开始时间">{formatDate(run.started_at)}</td><td data-label="结果">扫描 {run.discovered_count || 0} · 候选 {run.candidate_count || 0} · 成功 {run.success_count || 0} · 失败 {run.failed_count || 0}</td></tr>)}</tbody></table>{!recentRuns.length && <EmptyState title="还没有开奖清理任务" description="先选择账号进行一次只读预览。" />}</div></Panel>
    </>}
  </>;
}
