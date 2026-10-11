import QRCode from 'qrcode';
import { redactCookie } from './security';

const headers = (cookie?: string) => ({ accept: 'application/json, text/plain, */*', ...(cookie ? { cookie } : {}) });
async function json(url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
  return { data: await res.json().catch(() => ({})), headers: res.headers, status: res.status, ok: res.ok };
}

function safeError(error: unknown) {
  const value = error as Error & { cause?: { code?: string; message?: string } };
  const code = value?.cause?.code || value?.name || 'NETWORK_ERROR';
  const detail = value?.cause?.message || value?.message || '网络请求失败';
  return `${code}: ${detail}`.slice(0, 240);
}

export async function verifyBiliCookie(cookie: string) {
  try {
    const result = await json('https://api.bilibili.com/x/space/myinfo', { headers: headers(cookie) });
    if (result.data?.code === -101) return { ok: false as const, kind: 'invalid' as const, error: result.data?.message || 'Cookie 已失效' };
    if (!result.ok || result.data?.code !== 0) {
      const kind = result.status === 429 || result.status === 412 || result.data?.code === -412 ? 'rate_limited' : 'service';
      return { ok: false as const, kind, error: result.data?.message || `B站账号接口返回 HTTP ${result.status}` };
    }
    const stat = await json('https://api.bilibili.com/x/web-interface/nav/stat', { headers: headers(cookie) }).catch(() => ({ data: {}, headers: new Headers(), status: 0, ok: false }));
    return { ok: true as const, profile: { uid: String(result.data.data.mid), name: result.data.data.name, level: result.data.data.level, face: result.data.data.face, silence: result.data.data.silence, stat: stat.data?.data || {} } };
  } catch (error) {
    return { ok: false as const, kind: 'network' as const, error: safeError(error) };
  }
}

function dynamicText(item: any) {
  let value = item?.modules?.module_dynamic?.major?.archive?.desc || '';
  const nodes = item?.modules?.module_dynamic?.desc?.rich_text_nodes || item?.modules?.module_dynamic?.major?.opus?.summary?.rich_text_nodes || [];
  for (const node of nodes) value += node?.orig_text || node?.text || '';
  return String(value).trim();
}

export async function getDynamicDetail(cookie: string, dyid: string) {
  try {
    const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${encodeURIComponent(dyid)}`;
    const response = await json(url, { headers: { ...headers(cookie), 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' } });
    if (response.status === 429 || response.status === 412 || response.data?.code === -412 || response.data?.code === -352) return { ok: false as const, retryable: true, risk: true, error: response.data?.message || `HTTP ${response.status}` };
    if (!response.ok || response.data?.code !== 0 || !response.data?.data?.item) return { ok: false as const, retryable: false, risk: false, error: response.data?.message || `动态不存在或不可访问（HTTP ${response.status}）` };
    const wrapper = response.data.data.item;
    const item = wrapper?.type === 'DYNAMIC_TYPE_FORWARD' && wrapper?.orig?.id_str ? wrapper.orig : wrapper;
    const nodes = item?.modules?.module_dynamic?.desc?.rich_text_nodes || item?.modules?.module_dynamic?.major?.opus?.summary?.rich_text_nodes || [];
    return { ok: true as const, detail: {
      dyid: String(item.id_str || dyid), author: String(item?.modules?.module_author?.name || ''), description: dynamicText(item),
      official: nodes.some((node: any) => node?.type === 'RICH_TEXT_NODE_TYPE_LOTTERY'), sourceCreatedAt: Number(item?.modules?.module_author?.pub_ts || 0) || null,
      url: `https://t.bilibili.com/${String(item.id_str || dyid)}`
    } };
  } catch (error) { return { ok: false as const, retryable: true, risk: false, error: safeError(error) }; }
}

export async function getLotteryDrawTime(dyid: string) {
  try {
    const url = `https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice?dynamic_id=${encodeURIComponent(dyid)}`;
    const response = await json(url, { headers: headers() });
    if (response.data?.code === 0) return Number(response.data?.data?.lottery_time || 0) || null;
    return null;
  } catch { return null; }
}

export async function createQrSession() {
  const response = await json('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' } });
  const value = response.data?.data;
  if (!value?.url || !value?.qrcode_key) throw new Error('B 站二维码接口暂不可用');
  return { key: value.qrcode_key, url: value.url, image: await QRCode.toDataURL(value.url) };
}

export async function pollQrSession(key: string) {
  const query = new URLSearchParams({ qrcode_key: key, source: 'main-fe-header' });
  const response = await json(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?${query}`, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' } });
  const code = response.data?.data?.code;
  if (code !== 0) return { status: code === 86101 ? 'waiting' : code === 86090 ? 'scanned' : 'expired', message: response.data?.data?.message };
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookie = getSetCookie ? getSetCookie.call(response.headers).map(it => it.split(';')[0]).join('; ') : (response.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/).map(it => it.split(';')[0]).join('; ');
  if (!cookie) return { status: 'success', error: '扫码成功但没有获取到 Cookie' };
  return { status: 'success', cookie: redactCookie(cookie), rawCookie: cookie };
}
