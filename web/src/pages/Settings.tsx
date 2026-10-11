import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Bot, CheckCircle2, Clipboard, Code2, RotateCcw, Save, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { AnyObject, EmptyState, PageHeader, Panel, api } from '../core';

type ConfigField = { key: string; category: string; label: string; description?: string; type: string; unit?: string; min?: number; max?: number; step?: number; nullable?: boolean; readOnly?: boolean; options?: Array<{ value: string | number; label: string }> };
type ConfigPayload = { scope: 'default' | 'account'; inherited: boolean; effective: AnyObject; overrides: AnyObject; defaults: AnyObject; categories: Array<{ id: string; label: string; description: string }>; fields: ConfigField[] };

const sourceNames: AnyObject = { 0: '指定 UID', 1: '话题', 2: '专栏关键词', 3: '外部 API', 4: '本地文件', 5: '关注动态流', 6: '合集专栏账号' };

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <button type="button" className={`switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

function SourceOrder({ value, onChange }: { value: number[]; onChange: (value: number[]) => void }) {
  const enabled = new Set(value || []); const rows = Object.keys(sourceNames).map(Number).sort((left, right) => {
    const li = value.indexOf(left); const ri = value.indexOf(right); if (li < 0 && ri < 0) return left - right; if (li < 0) return 1; if (ri < 0) return -1; return li - ri;
  });
  function setEnabled(id: number, active: boolean) { onChange(active ? [...value, id] : value.filter(item => item !== id)); }
  function move(id: number, offset: number) { const list = [...value]; const index = list.indexOf(id); const target = index + offset; if (index < 0 || target < 0 || target >= list.length) return; [list[index], list[target]] = [list[target], list[index]]; onChange(list); }
  return <div className="source-order">{rows.map(id => <div className={enabled.has(id) ? 'source-order-row enabled' : 'source-order-row'} key={id}><Toggle checked={enabled.has(id)} onChange={active => setEnabled(id, active)} /><span>{sourceNames[id]}</span><div><button className="icon-button" type="button" disabled={!enabled.has(id) || value.indexOf(id) === 0} onClick={() => move(id, -1)} aria-label="上移"><ArrowUp size={16} /></button><button className="icon-button" type="button" disabled={!enabled.has(id) || value.indexOf(id) === value.length - 1} onClick={() => move(id, 1)} aria-label="下移"><ArrowDown size={16} /></button></div></div>)}</div>;
}

function AtUsersEditor({ value, onChange }: { value: any[]; onChange: (value: any[]) => void }) {
  const rows = Array.isArray(value) ? value : [];
  return <div className="repeat-editor">{rows.map((row, index) => <div className="repeat-row" key={`${row?.[1]}-${index}`}><input value={row?.[0] || ''} onChange={event => onChange(rows.map((item, itemIndex) => itemIndex === index ? [event.target.value, item?.[1] || ''] : item))} placeholder="名称" /><input inputMode="numeric" value={row?.[1] || ''} onChange={event => onChange(rows.map((item, itemIndex) => itemIndex === index ? [item?.[0] || '', Number(event.target.value) || ''] : item))} placeholder="UID" /><button className="button ghost compact" type="button" onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}>删除</button></div>)}<button className="button secondary compact" type="button" onClick={() => onChange([...rows, ['', '']])}>添加用户</button></div>;
}

function RandomModeEditor({ value, onChange }: { value: any[]; onChange: (value: any[]) => void }) {
  const current = Array.isArray(value) ? value : [[], []];
  const parse = (text: string) => text.split(/[,，\s]+/).map(Number).filter(Number.isFinite);
  return <div className="inline-fields"><label>每转发条数<input value={(current[0] || []).join(', ')} onChange={event => onChange([parse(event.target.value), current[1] || []])} /></label><label>发送随机动态条数<input value={(current[1] || []).join(', ')} onChange={event => onChange([current[0] || [], parse(event.target.value)])} /></label></div>;
}

function FieldEditor({ field, value, onChange }: { field: ConfigField; value: any; onChange: (value: any) => void }) {
  const id = `config-${field.key}`;
  if (field.key === 'LotteryOrder') return <SourceOrder value={value || []} onChange={onChange} />;
  if (field.key === 'at_users') return <AtUsersEditor value={value || []} onChange={onChange} />;
  if (field.key === 'create_dy_mode') return <RandomModeEditor value={value || []} onChange={onChange} />;
  if (field.key === 'dy_contents') return <textarea id={id} rows={5} value={(value || []).filter((item: unknown) => typeof item === 'string').join('\n')} onChange={event => onChange(event.target.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))} disabled={field.readOnly} />;
  if (field.key === 'FollowFeed') { const enabled = Array.isArray(value) && value.length > 0; return <div className="inline-setting"><Toggle checked={enabled} onChange={active => onChange(active ? [5] : null)} /><input id={id} type="number" min={1} max={20} value={enabled ? value[0] : 5} disabled={!enabled} onChange={event => onChange([Math.max(1, Math.min(20, Number(event.target.value) || 5))])} /><span>页</span></div>; }
  if (field.type === 'boolean') return <Toggle checked={Boolean(value)} onChange={onChange} disabled={field.readOnly} />;
  if (field.type === 'mode') { const mode = String(value || '00').padEnd(2, '0'); return <div className="mode-switches"><label><input type="checkbox" checked={mode[0] === '1'} onChange={event => onChange(`${event.target.checked ? '1' : '0'}${mode[1]}`)} />官方抽奖</label><label><input type="checkbox" checked={mode[1] === '1'} onChange={event => onChange(`${mode[0]}${event.target.checked ? '1' : '0'}`)} />非官方抽奖</label></div>; }
  if (field.type === 'string-list' || field.type === 'number-list') return <textarea id={id} rows={5} value={(value || []).join('\n')} onChange={event => { const rows = event.target.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean); onChange(field.type === 'number-list' ? rows.map(Number).filter(Number.isFinite) : rows); }} />;
  if (field.type === 'select') return <select id={id} value={value} onChange={event => { const sample = field.options?.[0]?.value; onChange(typeof sample === 'number' ? Number(event.target.value) : event.target.value); }}>{field.options?.map(option => <option value={option.value} key={String(option.value)}>{option.label}</option>)}</select>;
  if (field.type === 'number') {
    const unlimited = field.nullable && value === null;
    return <div className="number-control"><input id={id} type="number" min={field.min} max={field.max} step={field.step || 1} value={unlimited ? '' : value ?? ''} disabled={unlimited || field.readOnly} onChange={event => onChange(Number(event.target.value))} />{field.unit && <span>{field.unit}</span>}{field.nullable && <label className="check-control"><input type="checkbox" checked={unlimited} onChange={event => onChange(event.target.checked ? null : (field.min || 0))} />不限制</label>}</div>;
  }
  if (field.type === 'textarea') return <textarea id={id} rows={4} value={value ?? ''} onChange={event => onChange(event.target.value)} disabled={field.readOnly} />;
  return <input id={id} value={value ?? ''} onChange={event => onChange(event.target.value)} disabled={field.readOnly} />;
}

export function ConfigPage({ accounts, initialAccountId, onNotify, onNavigate }: AnyObject) {
  const [scope, setScope] = useState<'default' | 'account'>(initialAccountId ? 'account' : 'default'); const [accountId, setAccountId] = useState<number | null>(initialAccountId || accounts[0]?.id || null); const [payload, setPayload] = useState<ConfigPayload | null>(null); const [draft, setDraft] = useState<AnyObject>({}); const [category, setCategory] = useState('sources'); const [view, setView] = useState<'form' | 'json'>('form'); const [advanced, setAdvanced] = useState(false); const [jsonDraft, setJsonDraft] = useState(''); const [dirty, setDirty] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  async function load(targetScope = scope, id = accountId) {
    if (targetScope === 'account' && !id) { setPayload(null); return; }
    const next = await api<ConfigPayload>(targetScope === 'default' ? '/api/config' : `/api/accounts/${id}/config`);
    setPayload(next); setDraft(next.effective); setJsonDraft(JSON.stringify(next.effective, null, 2)); setDirty(false); setError(''); setAdvanced(false);
  }
  useEffect(() => { void load().catch(error => onNotify(error.message)); }, [scope, accountId]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (!dirty) return; event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty]);
  const fields = useMemo(() => payload?.fields.filter(field => field.category === category) || [], [payload, category]);
  function update(key: string, value: unknown) { setDraft(current => { const next = { ...current, [key]: value }; setJsonDraft(JSON.stringify(next, null, 2)); return next; }); setDirty(true); setError(''); }
  async function save() { if (scope === 'account' && !accountId) return; setSaving(true); setError(''); try { let value = draft; if (view === 'json' && advanced) { try { value = JSON.parse(jsonDraft); } catch { throw new Error('高级 JSON 格式错误，请修正后再保存'); } } const next = await api<ConfigPayload>(scope === 'default' ? '/api/config' : `/api/accounts/${accountId}/config`, { method: 'PUT', body: JSON.stringify(value) }); setPayload(next); setDraft(next.effective); setJsonDraft(JSON.stringify(next.effective, null, 2)); setDirty(false); onNotify(scope === 'default' ? '默认账号配置已保存，继承账号下次运行时生效' : '账号独立配置已保存'); } catch (error) { setError((error as Error).message); } finally { setSaving(false); } }
  async function resetDefaults() {
    if (!payload) return;
    if (scope === 'default') { if (!window.confirm('确定恢复程序内置配置吗？保存后所有继承账号都会使用这些值。')) return; setDraft(payload.defaults); setJsonDraft(JSON.stringify(payload.defaults, null, 2)); setDirty(true); return; }
    if (!accountId || !window.confirm('确定让当前账号恢复继承默认账号配置吗？AI 设置不会受到影响。')) return;
    const next = await api<ConfigPayload>(`/api/accounts/${accountId}/config/reset`, { method: 'POST' }); setPayload(next); setDraft(next.effective); setJsonDraft(JSON.stringify(next.effective, null, 2)); setDirty(false); onNotify('当前账号已恢复继承默认配置');
  }
  async function applyToAll() { if (!window.confirm('确定将默认配置应用到全部账号吗？所有账号的业务配置覆盖会被清除，AI 设置不受影响。')) return; const result = await api<AnyObject>('/api/config/apply-to-all', { method: 'POST' }); onNotify(`已将默认配置应用到 ${result.accounts || 0} 个账号`); }
  function switchScope(next: 'default' | 'account') { if (next === scope) return; if (dirty && !window.confirm('当前修改尚未保存，确定切换配置范围吗？')) return; setScope(next); }
  function enableAdvanced() { if (advanced || window.confirm('高级编辑会直接修改完整配置。保存前系统仍会校验字段，但错误值可能影响任务运行。确定开启吗？')) setAdvanced(true); }
  return <><PageHeader title="配置中心" description="默认账号配置统一管理公共规则；单账号只保存相对默认值的覆盖。" actions={<>{scope === 'default' && <button className="button secondary" onClick={applyToAll} disabled={!payload}>应用到全部账号</button>}<button className="button secondary" onClick={resetDefaults} disabled={!payload}><RotateCcw size={17} />{scope === 'default' ? '恢复程序默认' : '恢复继承默认'}</button><button className="button primary" onClick={save} disabled={(scope === 'account' && !accountId) || !dirty || saving}><Save size={17} />{saving ? '保存中' : scope === 'default' ? '保存默认配置' : '保存账号配置'}</button></>} />
    <div className="config-account-bar"><div className="segmented scope-segment"><button className={scope === 'default' ? 'active' : ''} onClick={() => switchScope('default')}>默认账号配置</button><button className={scope === 'account' ? 'active' : ''} onClick={() => switchScope('account')}>单账号配置</button></div>{scope === 'account' && <label>当前账号<select value={accountId || ''} onChange={event => { if (dirty && !window.confirm('当前修改尚未保存，确定切换账号吗？')) return; setAccountId(Number(event.target.value) || null); }}><option value="">选择账号</option>{accounts.map((account: AnyObject) => <option value={account.id} key={account.id}>{account.name || `账号 ${account.id}`}</option>)}</select></label>}{payload && <span className={`inheritance-badge ${scope === 'default' || payload.inherited ? 'inherited' : 'override'}`}>{scope === 'default' ? '所有账号默认值' : payload.inherited ? '继承默认' : '存在自定义覆盖'}</span>}{dirty && <span className="unsaved"><TriangleAlert size={16} />有未保存修改</span>}<div className="segmented"><button className={view === 'form' ? 'active' : ''} onClick={() => setView('form')}><SlidersHorizontal size={16} />表单配置</button><button className={view === 'json' ? 'active' : ''} onClick={() => setView('json')}><Code2 size={16} />JSON</button></div></div>
    {scope === 'account' && !accountId ? <Panel><EmptyState title="请先选择账号" /></Panel> : !payload ? <Panel><EmptyState title="正在加载配置" /></Panel> : <>{scope === 'default' && <div className="info-banner scope-info"><CheckCircle2 size={18} /><div><strong>新账号会自动使用这里的配置</strong><p>已有账号未单独修改的字段也会随默认值更新；“应用到全部账号”会清除业务配置覆盖。</p></div></div>}{view === 'json' ? <Panel title="完整 JSON" subtitle={advanced ? '高级编辑模式已开启，保存前会进行服务端校验。' : '当前为只读视图，可复制或导出。'} actions={<>{!advanced && <button className="button secondary compact" onClick={enableAdvanced}>开启高级编辑</button>}<button className="button ghost compact" onClick={() => navigator.clipboard.writeText(jsonDraft)}><Clipboard size={16} />复制</button></>}><textarea className="json-editor" value={jsonDraft} readOnly={!advanced} onChange={event => { setJsonDraft(event.target.value); setDirty(true); }} spellCheck={false} />{error && <div className="error-summary">{error}</div>}</Panel> : <div className="config-layout"><aside className="config-nav">{payload.categories.map(item => <button className={category === item.id ? 'active' : ''} onClick={() => setCategory(item.id)} key={item.id}>{item.label}</button>)}</aside><Panel title={payload.categories.find(item => item.id === category)?.label} subtitle={payload.categories.find(item => item.id === category)?.description} className="config-panel"><div className="config-fields">{fields.map(field => <div className={`config-field ${field.type === 'string-list' || field.type === 'number-list' || field.type === 'json' ? 'wide' : ''}`} key={field.key}><div className="field-copy"><label htmlFor={`config-${field.key}`}>{field.label}</label>{field.description && <p>{field.description}</p>}{payload.defaults[field.key] !== undefined && <small>{scope === 'default' ? '程序默认值' : '默认账号值'}：{payload.defaults[field.key] === null ? '不限制' : typeof payload.defaults[field.key] === 'object' ? JSON.stringify(payload.defaults[field.key]) : String(payload.defaults[field.key])}</small>}</div><FieldEditor field={field} value={draft[field.key]} onChange={value => update(field.key, value)} /></div>)}</div>{category === 'advanced' && <div className="info-banner"><Bot size={18} /><div><strong>AI 参数由“AI 设置”统一管理</strong><p>当前页面不会覆盖 API Key、模型和提示词，避免两处配置冲突。</p><button className="button ghost compact" onClick={() => onNavigate('ai')}>前往 AI 设置</button></div></div>}{error && <div className="error-summary">{error}</div>}</Panel></div>}</>}
  </>;
}
