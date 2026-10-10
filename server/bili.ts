import QRCode from 'qrcode';
import { redactCookie } from './security';

const headers = (cookie?: string) => ({ accept: 'application/json, text/plain, */*', ...(cookie ? { cookie } : {}) });
async function json(url: string, init: RequestInit = {}) { const res = await fetch(url, init); return { data: await res.json().catch(() => ({})), headers: res.headers }; }

export async function verifyBiliCookie(cookie: string) {
  const result = await json('https://api.bilibili.com/x/space/myinfo', { headers: headers(cookie) });
  if (result.data?.code !== 0) return { ok: false, error: result.data?.message || 'Cookie 已失效' };
  const stat = await json('https://api.bilibili.com/x/web-interface/nav/stat', { headers: headers(cookie) });
  return { ok: true, profile: { uid: String(result.data.data.mid), name: result.data.data.name, level: result.data.data.level, face: result.data.data.face, silence: result.data.data.silence, stat: stat.data?.data || {} } };
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
