import { createHash, randomBytes } from 'node:crypto';
import type { DailyConfig } from './daily';

export type DailyResult = {
  status: 'success' | 'completed' | 'skipped' | 'failed' | 'throttled';
  reason: string;
  providerCode?: number | null;
  providerMessage?: string | null;
  errorType?: string | null;
  httpStatus?: number | null;
  transportCode?: string | null;
  retryable?: boolean;
  attemptCount?: number;
  attempts?: DailyResult[];
};

export type DailyActionDetail = { targetId: string; result: DailyResult };
export type DailyActionOutcome = { result: DailyResult; targetId?: string; details?: DailyActionDetail[] };

type ApiReply<T = any> = { ok: boolean; result: DailyResult; data?: T; raw?: any };
type NavData = {
  isLogin?: boolean; mid?: number; money?: number; vipStatus?: number; vipType?: number;
  wallet?: { coupon_balance?: number }; level_info?: { current_level?: number };
  wbi_img?: { img_url?: string; sub_url?: string };
};
type Video = { aid: string; bvid: string; cid: string; duration: number; title: string };

const API = 'https://api.bilibili.com';
const LIVE = 'https://api.live.bilibili.com';
const MANGA = 'https://manga.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const completedPattern = /已(?:完成|领取|签到|参加|兑换|投币|分享)|重复|already|今日.*(?:完成|领取|签到)/i;
const mixinKeyEncTab = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function clean(value: unknown, limit = 500) {
  return String(value ?? '')
    .replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ••••••')
    .slice(0, limit);
}

function cookieValue(cookie: string, name: string) {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`, 'i'));
  return match?.[1] || '';
}

function failure(reason: string, extra: Partial<DailyResult> = {}): DailyResult {
  return { status: 'failed', reason: clean(reason), retryable: false, ...extra };
}

function businessResult(code: number, message: unknown, httpStatus?: number): DailyResult {
  const providerMessage = clean(message || '未知错误');
  if (completedPattern.test(providerMessage)) return { status: 'completed', reason: providerMessage, providerCode: code, providerMessage, httpStatus };
  return failure(`B站返回 ${code}${providerMessage ? `（${providerMessage}）` : ''}`, { providerCode: code, providerMessage, errorType: 'bili_api', httpStatus });
}

function visitId() {
  return `${Math.floor(Math.random() * 9) + 1}${randomBytes(5).toString('hex')}0`;
}

export class DailyBiliClient {
  readonly csrf: string;
  private navData: NavData | null = null;
  private riskPauseReason = '';

  constructor(private cookie: string, private config: DailyConfig) {
    this.csrf = cookieValue(cookie, 'bili_jct');
  }

  private headers(origin = 'https://www.bilibili.com', referer = `${origin}/`) {
    return { accept: 'application/json, text/plain, */*', cookie: this.cookie, origin, referer, 'user-agent': UA };
  }

  private async request<T>(url: string, init: RequestInit = {}, attempts = this.config.retryTimes + 1): Promise<ApiReply<T>> {
    if (this.riskPauseReason) return { ok: false, result: { status: 'throttled', reason: `风控暂停：${this.riskPauseReason}`, errorType: 'bili_api', retryable: false } };
    let last: DailyResult = failure('请求未执行', { errorType: 'local' }); const history: DailyResult[] = [];
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const text = await response.text();
        let body: any = null;
        try { body = text ? JSON.parse(text) : {}; } catch {
          last = failure(`响应格式异常（HTTP ${response.status}）`, { errorType: 'parse', httpStatus: response.status, retryable: response.status >= 500 });
          history.push({ ...last, attemptCount: attempt, attempts: undefined });
          if (last.retryable && attempt < attempts) { await sleep(Math.min(3000, 500 * attempt)); continue; }
          return { ok: false, result: { ...last, attemptCount: attempt, attempts: history } };
        }
        if (!response.ok) {
          const code = Number.isFinite(Number(body?.code)) ? Number(body.code) : null;
          const message = clean(body?.message || body?.msg || `HTTP ${response.status}`);
          if (code !== null && completedPattern.test(message)) return { ok: false, result: businessResult(code, message, response.status), raw: body };
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (response.status === 429 && attempt < attempts) { await sleep(Math.min(3000, 500 * attempt)); continue; }
          if (this.config.riskControl.pauseOnRisk && [412, 429].includes(response.status)) {
            this.riskPauseReason = `HTTP ${response.status}${message ? `（${message}）` : ''}，暂停本轮后续请求 ${this.config.riskControl.pauseMinutes} 分钟`;
            const result: DailyResult = { status: 'throttled', reason: this.riskPauseReason, providerCode: code, providerMessage: message, errorType: 'http', httpStatus: response.status, retryable: false, attemptCount: attempt }; history.push({ ...result }); return { ok: false, result: { ...result, attempts: history }, raw: body };
          }
          last = failure(`HTTP ${response.status}${message ? `（${message}）` : ''}`, { providerCode: code, providerMessage: message, errorType: 'http', httpStatus: response.status, retryable });
          history.push({ ...last, attemptCount: attempt, attempts: undefined });
          if (retryable && attempt < attempts) { await sleep(Math.min(3000, 500 * attempt)); continue; }
          return { ok: false, result: { ...last, attemptCount: attempt, attempts: history }, raw: body };
        }
        if (!body || !Number.isFinite(Number(body.code))) return { ok: false, result: failure('响应格式异常：缺少 B 站状态码', { errorType: 'parse', httpStatus: response.status }) };
        const code = Number(body.code);
        if (code !== 0) {
          const message = clean(body.message || body.msg || '未知错误');
          if (this.config.riskControl.pauseOnRisk && [-412, -352].includes(code)) {
            this.riskPauseReason = `B站返回 ${code}${message ? `（${message}）` : ''}，暂停本轮后续请求 ${this.config.riskControl.pauseMinutes} 分钟`;
            const result: DailyResult = { status: 'throttled', reason: this.riskPauseReason, providerCode: code, providerMessage: message, errorType: 'bili_api', httpStatus: response.status, retryable: false, attemptCount: attempt }; history.push({ ...result }); return { ok: false, result: { ...result, attempts: history }, raw: body };
          }
          const result = { ...businessResult(code, message, response.status), attemptCount: attempt }; history.push({ ...result }); return { ok: false, result: { ...result, attempts: history }, raw: body };
        }
        const result: DailyResult = { status: 'success', reason: '执行成功', providerCode: 0, httpStatus: response.status, attemptCount: attempt }; history.push({ ...result }); return { ok: true, result: { ...result, attempts: history }, data: body.data as T, raw: body };
      } catch (error) {
        const value = error as Error & { cause?: { code?: string; message?: string } };
        const timedOut = value.name === 'AbortError';
        const transportCode = clean(value.cause?.code || value.name || 'NETWORK_ERROR', 80);
        last = failure(timedOut ? '请求超时' : `网络错误：${clean(value.cause?.message || value.message || '请求失败', 300)}`, { errorType: timedOut ? 'timeout' : 'network', transportCode, retryable: true });
        history.push({ ...last, attemptCount: attempt, attempts: undefined });
        if (attempt < attempts) { await sleep(Math.min(3000, 500 * attempt)); continue; }
        return { ok: false, result: { ...last, attemptCount: attempt, attempts: history } };
      } finally { clearTimeout(timeout); }
    }
    return { ok: false, result: last };
  }

  private get<T>(url: string, origin?: string, referer?: string) {
    return this.request<T>(url, { headers: this.headers(origin, referer) });
  }

  private postForm<T>(url: string, form: Record<string, string | number>, origin = 'https://www.bilibili.com', referer = `${origin}/`) {
    return this.request<T>(url, { method: 'POST', headers: { ...this.headers(origin, referer), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(form).map(([key, value]) => [key, String(value)])) });
  }

  private postJson<T>(url: string, body: unknown, origin = 'https://www.bilibili.com', referer = `${origin}/`) {
    return this.request<T>(url, { method: 'POST', headers: { ...this.headers(origin, referer), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  private appParams(extra: Record<string, string | number> = {}) {
    const t = Date.now();
    return {
      build: '8451100', disable_rcmd: 0, mobi_app: 'android', platform: 'android',
      statistics: JSON.stringify({ appId: 1, platform: 3, version: '8.45.1', abtest: '' }),
      t, ts: Math.floor(t / 1000), ...extra
    };
  }

  private appSignedParams(extra: Record<string, string | number> = {}) {
    const appkey = '1d8b6e7d45233436'; const appsec = '560c52ccd288fed045859ed18bffd973';
    const params = { ...this.appParams(extra), appkey } as Record<string, string | number>;
    const query = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, String(value)])).toString();
    return `${query}&sign=${createHash('md5').update(`${query}${appsec}`).digest('hex')}`;
  }

  async validate(): Promise<ApiReply<NavData>> {
    const reply = await this.get<NavData>(`${API}/x/web-interface/nav`);
    if (!reply.ok) return reply;
    if (!reply.data?.isLogin || !reply.data.mid) return { ok: false, result: failure('账号未登录或 Cookie 已失效', { errorType: 'bili_api', providerCode: -101 }) };
    this.navData = reply.data;
    return { ...reply, result: { status: 'success', reason: `账号状态正常（Lv.${reply.data.level_info?.current_level ?? '?'}）`, providerCode: 0 } };
  }

  private async nav() {
    if (this.navData) return { ok: true, data: this.navData } as ApiReply<NavData>;
    return this.validate();
  }

  private requireCsrf(): DailyResult | null {
    return this.csrf ? null : failure('Cookie 缺少 bili_jct，无法执行写操作', { errorType: 'local' });
  }

  private async dailyStatus() {
    return this.get<{ login?: boolean; watch?: boolean; coins?: number; share?: boolean }>(`${API}/x/member/web/exp/reward`, 'https://account.bilibili.com', 'https://account.bilibili.com/account/home');
  }

  private async rankingVideos(): Promise<ApiReply<Video[]>> {
    const reply = await this.get<any>(`${API}/x/web-interface/ranking/v2?rid=0&type=all`);
    if (!reply.ok) return reply as ApiReply<Video[]>;
    const list = Array.isArray(reply.data?.list) ? reply.data.list : [];
    const videos = list.map((item: any) => ({ aid: String(item.aid || ''), bvid: String(item.bvid || ''), cid: String(item.cid || ''), duration: Math.max(1, Number(item.duration) || 15), title: clean(item.title, 120) })).filter((item: Video) => /^\d+$/.test(item.aid) && item.bvid && /^\d+$/.test(item.cid));
    if (!videos.length) return { ok: false, result: failure('排行榜没有可用视频，未执行写操作', { errorType: 'parse' }) };
    return { ...reply, data: videos.sort(() => Math.random() - 0.5) };
  }

  private async video() {
    const videos = await this.rankingVideos();
    if (!videos.ok) return { ok: false, result: videos.result } as ApiReply<Video>;
    return { ok: true, result: videos.result, data: videos.data![0] } as ApiReply<Video>;
  }

  async watchVideo(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const status = await this.dailyStatus(); if (!status.ok) return { result: status.result };
    if (status.data?.watch) return { result: { status: 'completed', reason: '今日观看任务已完成' } };
    const video = await this.video(); if (!video.ok) return { result: video.result };
    const nav = await this.nav(); if (!nav.ok) return { result: nav.result };
    const played = Math.max(1, Math.min(15, video.data!.duration));
    const form = { aid: video.data!.aid, bvid: video.data!.bvid, cid: video.data!.cid, mid: Number(nav.data!.mid), csrf: this.csrf, played_time: played, real_played_time: played, realtime: played, start_ts: Math.floor(Date.now() / 1000) - played, type: 3, dt: 2, play_type: 3 };
    const reply = await this.postForm(`${API}/x/click-interface/web/heartbeat?aid=${video.data!.aid}&played_time=${played}`, form);
    return { targetId: video.data!.bvid, result: reply.ok ? { status: 'success', reason: `已观看视频 ${video.data!.title}（${played} 秒）`, providerCode: 0 } : reply.result };
  }

  async shareVideo(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const status = await this.dailyStatus(); if (!status.ok) return { result: status.result };
    if (status.data?.share) return { result: { status: 'completed', reason: '今日分享任务已完成' } };
    const video = await this.video(); if (!video.ok) return { result: video.result };
    const reply = await this.postForm(`${API}/x/share/finish`, {
      ...this.appParams({ oid: video.data!.aid, csrf: this.csrf }),
      share_channel: 'QQ', share_id: 'main.ugc-video-detail.0.0.pv', share_origin: 'vinfo_share'
    });
    if (reply.result.providerCode === -403) {
      return {
        targetId: video.data!.bvid,
        result: {
          ...reply.result,
          status: 'skipped',
          retryable: false,
          reason: `B站返回 -403（${reply.result.providerMessage || '账号异常'}）；账号级分享风控，已跳过当日分享`
        }
      };
    }
    return { targetId: video.data!.bvid, result: reply.ok ? { status: 'success', reason: `已分享视频 ${video.data!.title}`, providerCode: 0 } : reply.result };
  }

  async coinVideo(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const limit = this.config.experience.coinLimit;
    if (limit <= 0) return { result: { status: 'skipped', reason: '每日投币上限为 0' } };
    const [exp, nav, videos] = await Promise.all([this.get<number>(`${API}/x/web-interface/coin/today/exp`), this.nav(), this.rankingVideos()]);
    if (!exp.ok) return { result: exp.result }; if (!nav.ok) return { result: nav.result }; if (!videos.ok) return { result: videos.result };
    const donated = Math.max(0, Math.floor(Number(exp.data) / 10));
    let needed = Math.max(0, limit - donated);
    if (!needed) return { result: { status: 'completed', reason: `今日已投 ${donated} 枚，达到配置上限` } };
    const available = Math.max(0, Math.floor(Number(nav.data!.money || 0) - this.config.experience.protectedCoins));
    needed = Math.min(needed, available);
    if (!needed) return { result: { status: 'skipped', reason: `硬币余额已达到保留值 ${this.config.experience.protectedCoins}` } };
    const details: DailyActionDetail[] = [];
    for (const video of videos.data!.slice(0, 12)) {
      if (details.filter(item => item.result.status === 'success').length >= needed) break;
      const prior = await this.get<any>(`${API}/x/web-interface/archive/coins?aid=${encodeURIComponent(video.aid)}`);
      if (!prior.ok) { details.push({ targetId: video.bvid, result: prior.result }); continue; }
      if (Number(prior.data?.multiply || 0) >= 2) continue;
      const reply = await this.postForm(`${API}/x/web-interface/coin/add`, { aid: video.aid, multiply: 1, select_like: this.config.experience.likeWhenCoin ? 1 : 0, cross_domain: 'true', csrf: this.csrf, eab_x: 2, ramval: 3, source: 'web_normal', ga: 1 }, 'https://www.bilibili.com', `https://www.bilibili.com/video/${video.bvid}/`);
      details.push({ targetId: video.bvid, result: reply.ok ? { status: 'success', reason: `已向 ${video.title} 投 1 枚硬币${this.config.experience.likeWhenCoin ? '并点赞' : ''}`, providerCode: 0 } : reply.result });
      if (this.config.requestDelay > 0) await sleep(this.config.requestDelay);
    }
    const successes = details.filter(item => item.result.status === 'success').length;
    if (successes === needed) return { result: { status: 'success', reason: `投币完成：成功 ${successes} 枚` }, details };
    return { result: failure(`投币未完成：目标 ${needed} 枚，成功 ${successes} 枚${details.length ? '，详见目标记录' : '，没有找到可投币视频'}`), details };
  }

  private mixinKey(nav: NavData) {
    const img = String(nav.wbi_img?.img_url || '').split('/').pop()?.split('.')[0] || '';
    const sub = String(nav.wbi_img?.sub_url || '').split('/').pop()?.split('.')[0] || '';
    const source = img + sub;
    return mixinKeyEncTab.map(index => source[index] || '').join('').slice(0, 32);
  }

  private signedQuery(params: Record<string, string | number>, nav: NavData) {
    const wts = Math.floor(Date.now() / 1000); const values: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...params, wts })) values[key] = String(value).replace(/[!'()*]/g, '');
    const query = Object.keys(values).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(values[key])}`).join('&');
    return `${query}&w_rid=${createHash('md5').update(query + this.mixinKey(nav)).digest('hex')}`;
  }

  async liveLottery(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    if (this.config.liveLottery.maxPerDay <= 0) return { result: { status: 'skipped', reason: '直播抽奖每日次数上限为 0' } };
    const index = await this.get<any>(`${LIVE}/xlive/web-interface/v1/index/getList?platform=web`, 'https://live.bilibili.com');
    if (!index.ok) return { result: index.result };
    const groups = Array.isArray(index.data?.room_list) ? index.data.room_list : [];
    const rooms = groups.flatMap((group: any) => Array.isArray(group?.list) ? group.list : []);
    const candidates: any[] = rooms.filter((room: any) => {
      const pendants = Object.values(room.pendant_info || room.pendant_Info || {}) as any[];
      return pendants.some(item => Number(item?.pendent_id ?? item?.pendant_id) === 504);
    });

    const followed = await this.get<any>(`${LIVE}/xlive/web-ucenter/user/following?page=1&page_size=9`, 'https://live.bilibili.com');
    if (followed.ok) candidates.push(...(Array.isArray(followed.data?.list) ? followed.data.list.filter((room: any) => Number(room.live_status) === 1) : []));

    const details: DailyActionDetail[] = []; const seen = new Set<string>();
    for (const room of candidates) {
      if (details.filter(item => item.result.status === 'success').length >= this.config.liveLottery.maxPerDay) break;
      const roomId = String(room.roomid || ''); if (!roomId || seen.has(roomId)) continue;
      seen.add(roomId);
      const check = await this.get<any>(`${LIVE}/xlive/lottery-interface/v1/Anchor/Check?roomid=${encodeURIComponent(roomId)}`, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
      if (!check.ok) { details.push({ targetId: roomId, result: check.result }); continue; }
      const lottery = check.data || {}; const award = clean(lottery.award_name, 120);
      const excluded = this.config.liveLottery.excludeKeywords.some(word => award.includes(word));
      const included = !this.config.liveLottery.includeKeywords.length || this.config.liveLottery.includeKeywords.some(word => award.includes(word));
      if (Number(lottery.status) !== 1 || excluded || !included || Number(lottery.send_gift_ensure) !== 0 || ![0, 1].includes(Number(lottery.require_type ?? 0)) || Number(lottery.gift_num || 0) > 0 || Number(lottery.gift_price || 0) > 0) continue;
      const join = await this.postForm<any>(`${LIVE}/xlive/lottery-interface/v1/Anchor/Join`, { id: Number(lottery.id), gift_id: Number(lottery.gift_id || 0), gift_num: Number(lottery.gift_num || 0), csrf: this.csrf, csrf_token: this.csrf, visit_id: visitId(), platform: 'pc' }, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
      details.push({ targetId: roomId, result: join.ok ? { status: 'success', reason: `已参加直播间 ${roomId} 的天选抽奖：${award || '未命名奖品'}`, providerCode: 0 } : join.result });
      if (this.config.requestDelay > 0) await sleep(this.config.requestDelay);
    }
    const joined = details.filter(item => item.result.status === 'success').length;
    if (joined) return { result: { status: 'success', reason: `直播天选抽奖已参加 ${joined} 场` }, details };
    if (details.some(item => item.result.status === 'failed')) return { result: failure('未成功参加直播天选抽奖，详见目标记录'), details };
    return { result: { status: 'completed', reason: '未发现符合筛选条件且可安全参加的直播天选抽奖' }, details };
  }

  async vipBigPoint(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const nav = await this.nav(); if (!nav.ok) return { result: nav.result };
    if (Number(nav.data!.vipStatus) !== 1) return { result: { status: 'skipped', reason: '当前账号不是有效大会员' } };
    const origin = 'https://big.bilibili.com'; const referer = `${origin}/mobile/bigPoint/task`;
    const details: DailyActionDetail[] = [];
    const signQuery = new URLSearchParams(Object.entries(this.appParams({ csrf: this.csrf })).map(([key, value]) => [key, String(value)]));
    const signInfo = await this.get<any>(`${API}/x/vip/vip_center/sign_in/three_days_sign?${signQuery}`, origin, referer);
    if (!signInfo.ok) return { result: signInfo.result };
    if (signInfo.data?.three_day_sign?.signed === true) {
      details.push({ targetId: 'sign', result: { status: 'completed', reason: 'VIP 大积分今日已签到' } });
    } else {
      const t = Date.now();
      const sign = await this.postJson<any>(`${API}/pgc/activity/score/task/sign2?mobi_app=android&platform=android&csrf=${encodeURIComponent(this.csrf)}`, { device: 'phone', t, ts: Math.floor(t / 1000) }, origin, `${origin}/mobile/index`);
      details.push({ targetId: 'sign', result: sign.ok ? { status: 'success', reason: 'VIP 大积分签到成功', providerCode: 0 } : sign.result });
      if (sign.result.status === 'throttled') return { result: sign.result, details };
    }

    const buvid = cookieValue(this.cookie, 'buvid3');
    const combineQuery = new URLSearchParams(Object.entries(this.appParams({ buvid, csrf: this.csrf, brand: 'Samsung', channel: 'bili', containerName: 'AbstractWebActivity', device: 'phone' })).map(([key, value]) => [key, String(value)]));
    const combine = await this.get<any>(`${API}/x/vip_point/task/combine?${combineQuery}`, origin, referer);
    if (!combine.ok) return { result: combine.result, details };
    const modules = combine.data?.task_info?.modules;
    if (!Array.isArray(modules)) return { result: failure('VIP 大积分任务响应格式异常：缺少任务模块', { errorType: 'parse' }), details };
    const safeCodes = new Set(['bonus', 'privilege', 'dress-view', 'animatetab', 'filmtab', 'ogvwatchnew']);
    const tasks = modules.flatMap((module: any) => Array.isArray(module?.common_task_item) ? module.common_task_item : []).filter((task: any) => safeCodes.has(String(task?.task_code || '')));
    for (const task of tasks) {
      const taskCode = String(task.task_code); const title = clean(task.title || taskCode, 120);
      const state = Number(task.state);
      if (!Number.isFinite(state)) {
        details.push({ targetId: taskCode, result: failure(`${title}的任务状态无法识别，未发送完成请求`, { errorType: 'parse' }) });
        continue;
      }
      if (state === 3) {
        details.push({ targetId: taskCode, result: { status: 'completed', reason: `${title}已完成` } });
        continue;
      }
      if (state === 0) {
        const receive = await this.postForm<any>(`${API}/pgc/activity/score/task/receive/v2`, { taskCode }, origin, referer);
        if (!receive.ok && receive.result.status !== 'completed') {
          details.push({ targetId: taskCode, result: receive.result });
          if (receive.result.status === 'throttled') break;
          continue;
        }
      }
      let complete: ApiReply<any>;
      if (taskCode === 'bonus' || taskCode === 'privilege') {
        complete = await this.postJson<any>(`${API}/pgc/activity/score/task/complete`, { taskCode }, origin, referer);
      } else if (taskCode === 'animatetab' || taskCode === 'filmtab') {
        complete = await this.postForm<any>(`${API}/pgc/activity/deliver/task/complete`, { ...this.appParams(), position: taskCode === 'animatetab' ? 'jp_channel' : 'tv_channel', c_locale: 'zh_CN', channel: 'bili', s_locale: 'zh_CN' }, origin, referer);
      } else {
        complete = await this.postForm<any>(`${API}/pgc/activity/score/task/complete/v2`, { taskCode }, origin, referer);
      }
      details.push({ targetId: taskCode, result: complete.ok ? { status: 'success', reason: `${title}处理成功`, providerCode: 0 } : complete.result });
      if (complete.result.status === 'throttled') break;
      if (this.config.requestDelay > 0) await sleep(this.config.requestDelay);
    }
    const failures = details.filter(item => ['failed', 'throttled'].includes(item.result.status));
    const changed = details.filter(item => item.result.status === 'success').length;
    if (failures.length) return { result: failure(`VIP 大积分部分任务失败：${failures.length} 项，详见目标记录`), details };
    return { result: { status: changed ? 'success' : 'completed', reason: changed ? `VIP 大积分处理完成：成功 ${changed} 项` : 'VIP 大积分今日已完成' }, details };
  }

  async fansMedal(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    if (this.config.fansMedal.maxActions <= 0) return { result: { status: 'skipped', reason: '粉丝勋章每日互动上限为 0' } };
    const nav = await this.nav(); if (!nav.ok) return { result: nav.result };
    const details: DailyActionDetail[] = []; const medals = new Map<string, any>();
    for (let page = 1; page <= 100; page += 1) {
      const reply = await this.get<any>(`${LIVE}/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=10`, 'https://live.bilibili.com');
      if (!reply.ok) return { result: reply.result, details };
      const data = reply.data || {};
      if (!Array.isArray(data.special_list) || !Array.isArray(data.list) || !data.page_info || typeof data.page_info !== 'object') return { result: failure('粉丝勋章列表响应格式异常，未发送点赞', { errorType: 'parse' }), details };
      const items = [...data.special_list, ...data.list];
      for (const item of items) {
        const anchorId = String(item?.medal?.target_id || ''); const roomId = String(item?.room_info?.room_id || '');
        if (/^\d+$/.test(anchorId) && /^\d+$/.test(roomId) && anchorId !== '0' && roomId !== '0') medals.set(anchorId, item);
      }
      if (!data.page_info?.has_more && page >= Math.max(1, Number(data.page_info?.total_page || 1))) break;
      if (this.config.requestDelay > 0) await sleep(Math.min(this.config.requestDelay, 3000));
    }
    let sent = 0;
    for (const [anchorId, medal] of medals) {
      if (sent >= this.config.fansMedal.maxActions) break;
      const roomId = String(medal.room_info.room_id); const label = clean(medal.medal?.medal_name || medal.anchor_info?.nick_name || anchorId, 80);
      const taskInfo = await this.get<any>(`${LIVE}/xlive/app-ucenter/v1/fansMedal/GetActivatedMedalInfo?target_id=${encodeURIComponent(anchorId)}&csrf=${encodeURIComponent(this.csrf)}&web_location=444.260`, 'https://live.bilibili.com');
      if (!taskInfo.ok) { details.push({ targetId: anchorId, result: taskInfo.result }); if (taskInfo.result.status === 'throttled') break; continue; }
      if (!Array.isArray(taskInfo.data?.task_info)) { details.push({ targetId: anchorId, result: failure(`${label}的粉丝勋章进度响应格式异常，未发送点赞`, { errorType: 'parse' }) }); continue; }
      const task = taskInfo.data.task_info.find((item: any) => item?.jump_type === 'like');
      if (!task || task.is_done || (taskInfo.data?.is_lighted && taskInfo.data?.reach_free_intimacy_limit)) {
        details.push({ targetId: anchorId, result: { status: 'completed', reason: `${label}的点赞任务已完成` } });
        continue;
      }
      const quantity = String(task.title || '').match(/\d+(?:\.\d+)?/); const progress = String(task.sub_title || '').match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
      const roundSize = quantity ? Math.ceil(Number(quantity[0])) : 0;
      if (!roundSize || roundSize > 1000) { details.push({ targetId: anchorId, result: failure(`${label}的粉丝勋章任务要求无法识别，未发送点赞`, { errorType: 'parse' }) }); continue; }
      let remaining = roundSize;
      if (progress) remaining = Math.ceil(Math.max(0, Number(progress[2]) - Number(progress[1])) * roundSize);
      else if (taskInfo.data?.is_lighted) { details.push({ targetId: anchorId, result: failure(`${label}的粉丝勋章任务进度无法识别，未发送点赞`, { errorType: 'parse' }) }); continue; }
      if (!remaining) { details.push({ targetId: anchorId, result: { status: 'completed', reason: `${label}的点赞任务已完成` } }); continue; }
      const room = await this.get<any>(`${LIVE}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}&from=room`, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
      if (!room.ok) { details.push({ targetId: anchorId, result: room.result }); continue; }
      if (!Number.isFinite(Number(room.data?.live_status))) { details.push({ targetId: anchorId, result: failure(`${label}的直播状态响应格式异常，未发送点赞`, { errorType: 'parse' }) }); continue; }
      if (Number(room.data?.live_status) !== 1) { details.push({ targetId: anchorId, result: { status: 'skipped', reason: `${label}当前未直播，未发送点赞` } }); continue; }
      const amount = Math.min(10, remaining, this.config.fansMedal.maxActions - sent);
      const like = await this.postForm<any>(`${LIVE}/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3`, { click_time: amount, room_id: roomId, uid: Number(nav.data!.mid), anchor_id: anchorId, csrf_token: this.csrf, csrf: this.csrf }, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
      details.push({ targetId: anchorId, result: like.ok ? { status: 'success', reason: `已向 ${label} 的直播间发送 ${amount} 次点赞`, providerCode: 0 } : like.result });
      if (like.ok) sent += amount;
      if (like.result.status === 'throttled') break;
      if (this.config.requestDelay > 0) await sleep(this.config.requestDelay);
    }
    const failures = details.filter(item => ['failed', 'throttled'].includes(item.result.status));
    if (failures.length) return { result: failure(`粉丝勋章任务部分失败：${failures.length} 项，已发送 ${sent} 次点赞`), details };
    return { result: { status: sent ? 'success' : 'completed', reason: sent ? `粉丝勋章任务已发送 ${sent} 次直播点赞` : '没有需要且可以安全执行的粉丝勋章点赞任务' }, details };
  }

  async mangaSign(): Promise<DailyActionOutcome> {
    const platform = this.config.experience.devicePlatform;
    const reply = await this.request<any>(`${MANGA}/twirp/activity.v1.Activity/ClockIn?platform=${platform}`, { method: 'POST', headers: this.headers('https://manga.bilibili.com') });
    return { result: reply.ok ? { status: 'success', reason: '漫画签到成功', providerCode: 0 } : reply.result };
  }

  async mangaRead(): Promise<DailyActionOutcome> {
    const platform = this.config.experience.devicePlatform;
    const targetId = '27355:381662';
    const reply = await this.request<any>(`${MANGA}/twirp/bookshelf.v1.Bookshelf/AddHistory?platform=${platform}&comic_id=27355&ep_id=381662`, { method: 'POST', headers: this.headers('https://manga.bilibili.com') });
    return { targetId, result: reply.ok ? { status: 'success', reason: '漫画阅读记录已提交', providerCode: 0 } : reply.result };
  }

  async mangaPrivilege(): Promise<DailyActionOutcome> {
    const nav = await this.nav(); if (!nav.ok) return { result: nav.result };
    if (Number(nav.data!.vipStatus) !== 1) return { result: { status: 'skipped', reason: '当前账号不是有效大会员' } };
    const reply = await this.request<any>(`${MANGA}/twirp/user.v1.User/GetVipReward?reason_id=1`, { method: 'POST', headers: this.headers('https://manga.bilibili.com') });
    return { targetId: '1', result: reply.ok ? { status: 'success', reason: `漫画权益领取成功${reply.data?.amount ? `（${reply.data.amount} 张漫读券）` : ''}`, providerCode: 0 } : reply.result };
  }

  async silverToCoin(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const status = await this.get<any>(`${LIVE}/xlive/revenue/v1/wallet/getStatus`, 'https://link.bilibili.com');
    if (!status.ok) return { result: status.result };
    const left = Math.max(0, Number(status.data?.silver_2_coin_left || 0));
    const count = Math.min(left, this.config.silver2Coin.maxExchanges);
    if (!count) return { result: { status: 'completed', reason: '今日已无银瓜子兑换硬币次数' } };
    const details: DailyActionDetail[] = [];
    for (let index = 0; index < count; index += 1) {
      const reply = await this.postForm<any>(`${LIVE}/xlive/revenue/v1/wallet/silver2coin`, { csrf: this.csrf, csrf_token: this.csrf, visit_id: visitId() }, 'https://link.bilibili.com');
      const result = !reply.ok && (reply.result.providerCode === 403 || /银瓜子余额不足|余额不足/.test(reply.result.providerMessage || reply.result.reason || ''))
        ? { status: 'skipped' as const, reason: `银瓜子余额不足，跳过第 ${index + 1} 次兑换` }
        : reply.ok ? { status: 'success' as const, reason: `第 ${index + 1} 次兑换成功`, providerCode: 0 } : reply.result;
      details.push({ targetId: String(index + 1), result });
      if (!reply.ok) break;
    }
    const successes = details.filter(item => item.result.status === 'success').length;
    const failures = details.filter(item => ['failed', 'throttled'].includes(item.result.status));
    if (!failures.length && !successes) return { result: { status: 'skipped', reason: '银瓜子余额不足，未执行兑换' }, details };
    return { result: successes === count ? { status: 'success', reason: `银瓜子兑换成功 ${successes} 次` } : failure(`银瓜子兑换未完成：计划 ${count} 次，成功 ${successes} 次`), details };
  }

  async charge(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const nav = await this.nav(); if (!nav.ok) return { result: nav.result };
    if (Number(nav.data!.vipStatus) !== 1 || Number(nav.data!.vipType) !== 2) return { result: { status: 'skipped', reason: '仅年度大会员可使用 B 币券充电' } };
    const balance = Number(nav.data!.wallet?.coupon_balance || 0); const amount = Math.min(balance, this.config.charge.maxPerDay);
    if (amount < 1) return { result: { status: 'completed', reason: '可用 B 币券不足 1 个' } };
    const uid = this.config.charge.targetUid;
    const reply = await this.postForm<any>(`${API}/x/ugcpay/web/v2/trade/elec/pay/quick`, { bp_num: amount, is_bp_remains_prior: 'true', up_mid: uid, otype: 'up', oid: uid, csrf: this.csrf });
    if (!reply.ok) return { targetId: uid, result: reply.result };
    if (Number(reply.data?.status) !== 4) return { targetId: uid, result: failure(`充电响应状态异常（status=${clean(reply.data?.status, 20)}），未确认成功`, { errorType: 'parse' }) };
    return { targetId: uid, result: { status: 'success', reason: `已向 UP 主 ${uid} 充电 ${amount} 个 B 币`, providerCode: 0 } };
  }

  async vipPrivilege(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const nav = await this.nav(); if (!nav.ok) return { result: nav.result };
    if (Number(nav.data!.vipStatus) !== 1 || Number(nav.data!.vipType) !== 2) return { result: { status: 'skipped', reason: '当前账号不是年度大会员' } };
    const details: DailyActionDetail[] = [];
    for (const type of [1, 2]) {
      const reply = await this.postForm<any>(`${API}/x/vip/privilege/receive?type=${type}&csrf=${encodeURIComponent(this.csrf)}`, {});
      details.push({ targetId: String(type), result: reply.ok ? { status: 'success', reason: type === 1 ? '年度大会员 B 币券领取成功' : '大会员权益领取成功', providerCode: 0 } : reply.result });
    }
    const failed = details.filter(item => item.result.status === 'failed');
    if (failed.length === details.length) return { result: failure('VIP 权益领取失败，详见目标记录'), details };
    return { result: { status: 'success', reason: `VIP 权益处理完成：${details.length - failed.length}/${details.length}` }, details };
  }

  private outcome(label: string, details: DailyActionDetail[]): DailyActionOutcome {
    const failed = details.filter(item => ['failed', 'throttled'].includes(item.result.status));
    const done = details.filter(item => ['success', 'completed'].includes(item.result.status));
    if (!details.length) return { result: { status: 'completed', reason: `${label}没有可执行项目` }, details };
    if (failed.length && !done.length) return { result: failure(`${label}失败，详见目标记录`), details };
    if (failed.length) return { result: failure(`${label}部分失败：成功 ${done.length} 项，失败 ${failed.length} 项`), details };
    return { result: { status: done.some(item => item.result.status === 'success') ? 'success' : 'completed', reason: `${label}处理完成：${done.length} 项` }, details };
  }

  async liveSign(): Promise<DailyActionOutcome> {
    const info = await this.get<any>(`${LIVE}/xlive/web-ucenter/v1/sign/WebGetSignInfo`, 'https://live.bilibili.com');
    if (!info.ok) return { result: info.result };
    if (Number(info.data?.is_signed) === 1 || Number(info.data?.status) === 1) return { result: { status: 'completed', reason: '直播签到今日已完成' } };
    const reply = await this.get<any>(`${LIVE}/xlive/web-ucenter/v1/sign/DoSign`, 'https://live.bilibili.com');
    if (!reply.ok && (reply.result.providerCode === 1 || /活动已下线|无法使用/.test(reply.result.providerMessage || reply.result.reason || ''))) {
      return { result: { status: 'skipped', reason: `直播签到不可用：${reply.result.providerMessage || reply.result.reason || '活动已下线'}` } };
    }
    return { result: reply.ok ? { status: 'success', reason: '直播签到成功', providerCode: 0, attempts: reply.result.attempts } : reply.result };
  }

  async supportGroupSign(): Promise<DailyActionOutcome> {
    const groups = await this.get<any>(`${VC}/link_group/v1/member/my_groups`, 'https://message.bilibili.com');
    if (!groups.ok) return { result: groups.result };
    const list = Array.isArray(groups.data?.list) ? groups.data.list : Array.isArray(groups.data) ? groups.data : [];
    if (!list.length) return { result: { status: 'completed', reason: '没有可签到的应援团' } };
    const details: DailyActionDetail[] = [];
    for (const group of list) {
      const groupId = String(group.group_id || group.id || ''); const ownerId = String(group.owner_id || group.owner_uid || '');
      if (!/^\d+$/.test(groupId) || !/^\d+$/.test(ownerId)) { details.push({ targetId: groupId || 'unknown', result: failure('应援团数据缺少 group_id 或 owner_id', { errorType: 'parse' }) }); continue; }
      const reply = await this.get<any>(`${VC}/link_setting/v1/link_setting/sign_in?group_id=${groupId}&owner_id=${ownerId}`, 'https://message.bilibili.com');
      details.push({ targetId: groupId, result: reply.ok ? { status: 'success', reason: `应援团 ${groupId} 签到成功`, providerCode: 0, attempts: reply.result.attempts } : reply.result });
      if (this.config.requestDelay) await sleep(this.config.requestDelay);
    }
    return this.outcome('应援团签到', details);
  }

  async vipExperience(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const reply = await this.postForm<any>(`${API}/x/vip/experience/add?${this.appSignedParams({ csrf: this.csrf })}`, {});
    if (!reply.ok && (reply.result.providerCode === 235007 || /非有效大会员|不是有效大会员/.test(reply.result.providerMessage || reply.result.reason || ''))) {
      return { result: { status: 'skipped', reason: `当前账号不是有效大会员：${reply.result.providerMessage || reply.result.reason || '无需领取 VIP 经验'}` } };
    }
    return { result: reply.ok ? { status: 'success', reason: 'VIP 每日经验领取成功', providerCode: 0, attempts: reply.result.attempts } : reply.result };
  }

  async mangaShare(): Promise<DailyActionOutcome> {
    const reply = await this.postJson<any>(`${MANGA}/twirp/activity.v1.Activity/ShareComic?platform=android`, { is_teenager: 0, no_recommend: 0, mobi_app: 'android_comic', platform: 'android', channel: 'bilicomic', ts: Date.now() }, 'https://manga.bilibili.com');
    return { result: reply.ok ? { status: 'success', reason: '漫画分享任务完成', providerCode: 0, attempts: reply.result.attempts } : reply.result };
  }

  async bigPointExchange(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const { bigPointToken: token, bigPointPrice: price } = this.config.resourceTasks;
    const referer = `https://big.bilibili.com/mobile/bigPoint/sku/${encodeURIComponent(token)}`;
    const signed = this.appSignedParams({ token, csrf: this.csrf, ...(price ? { price } : {}) });
    const headers = { ...this.headers('https://big.bilibili.com', referer), 'content-type': 'application/x-www-form-urlencoded' };
    const verify = await this.request<any>(`${API}/x/vip_point/trade/order/verify`, { method: 'POST', headers, body: signed });
    if (!verify.ok) return { targetId: token, result: verify.result };
    const create = await this.request<any>(`${API}/x/vip_point/trade/order/create`, { method: 'POST', headers, body: signed });
    if (!create.ok) return { targetId: token, result: create.result };
    const orderNo = String(create.data?.order_no || create.data?.orderNo || '');
    if (!orderNo) return { targetId: token, result: failure('大积分兑换响应缺少订单号，未确认兑换成功', { errorType: 'parse' }) };
    const payment = await this.get<any>(`${API}/x/vip_point/trade/order/payment?${this.appSignedParams({ order_no: orderNo, csrf: this.csrf })}`, 'https://big.bilibili.com', `https://big.bilibili.com/mobile/bigPoint/orderResult?order_no=${encodeURIComponent(orderNo)}`);
    return { targetId: token, result: payment.ok ? { status: 'success', reason: `大积分商品兑换成功（订单 ${orderNo}）`, providerCode: 0, attempts: payment.result.attempts } : payment.result };
  }

  async mangaPointExchange(): Promise<DailyActionOutcome> {
    const { mangaProductId, mangaPointCost, mangaQuantity } = this.config.resourceTasks;
    const balance = await this.postJson<any>(`${MANGA}/twirp/pointshop.v1.Pointshop/GetUserPoint`, {}, 'https://manga.bilibili.com');
    if (!balance.ok) return { result: balance.result };
    if (Number(balance.data?.point || 0) < mangaPointCost * mangaQuantity) return { result: { status: 'skipped', reason: `漫画积分不足，需要 ${mangaPointCost * mangaQuantity}` } };
    const reply = await this.postJson<any>(`${MANGA}/twirp/pointshop.v1.Pointshop/Exchange`, { product_id: mangaProductId, point: mangaPointCost, product_num: mangaQuantity }, 'https://manga.bilibili.com');
    return { targetId: String(mangaProductId), result: reply.ok ? { status: 'success', reason: `漫画积分商品 ${mangaProductId} 兑换成功`, providerCode: 0, attempts: reply.result.attempts } : reply.result };
  }

  async expiringGift(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const nav = await this.nav(); if (!nav.ok) return { result: nav.result };
    const { giftRoomId: roomId, giftReceiverUid: receiverUid, giftExpireHours, giftMaxCount } = this.config.resourceTasks;
    const bag = await this.get<any>(`${LIVE}/xlive/web-room/v1/gift/bag_list?t=${Date.now()}&room_id=${roomId}`, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
    if (!bag.ok) return { result: bag.result };
    const list = Array.isArray(bag.data?.list) ? bag.data.list : [];
    const cutoff = Math.floor(Date.now() / 1000) + giftExpireHours * 3600;
    const candidates = list.filter((item: any) => Number(item.expire_at || 0) > 0 && Number(item.expire_at) <= cutoff && Number(item.gift_num || 0) > 0).slice(0, giftMaxCount);
    const details: DailyActionDetail[] = [];
    for (const item of candidates) {
      const count = Math.max(1, Math.min(Number(item.gift_num) || 1, giftMaxCount));
      const reply = await this.postForm<any>(`${LIVE}/xlive/revenue/v2/gift/sendBag`, { gift_id: Number(item.gift_id), ruid: Number(receiverUid), gift_num: count, bag_id: Number(item.bag_id), biz_id: Number(roomId), rnd: Date.now(), send_ruid: 0, storm_beat_id: 0, metadata: '', price: 0, visit_id: '', csrf: this.csrf, platform: 'pc', biz_code: 'Live', csrf_token: this.csrf, uid: Number(nav.data!.mid) }, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
      details.push({ targetId: String(item.bag_id), result: reply.ok ? { status: 'success', reason: `已投喂 ${clean(item.gift_name || item.gift_id, 80)} × ${count}`, providerCode: 0, attempts: reply.result.attempts } : reply.result });
      if (this.config.requestDelay) await sleep(this.config.requestDelay);
    }
    return this.outcome('临期礼物投喂', details);
  }

  async liveWeeklyReward(): Promise<DailyActionOutcome> {
    const center = await this.get<any>(`${LIVE}/xlive/anchor-task-interface/api/v1/GetAnchorTaskCenterInfo?${this.appSignedParams()}`, 'https://link.bilibili.com');
    if (!center.ok) return { result: center.result };
    const groups = Array.isArray(center.data?.taskGroups) ? center.data.taskGroups : [];
    const pending = groups.some((item: any) => item?.weekTaskInfo?.weekDailyTask?.isFinished === false);
    if (pending) return { result: { status: 'skipped', reason: '直播每周任务尚未完成，未尝试领取' } };
    const reward = await this.get<any>(`${LIVE}/xlive/anchor-task-interface/api/v1/GetAnchorTaskCenterReceiveReward?${this.appSignedParams()}`, 'https://link.bilibili.com');
    return { result: reward.ok ? { status: 'success', reason: '直播每周奖励领取成功', providerCode: 0, attempts: reward.result.attempts } : reward.result };
  }

  async dailyBattery(): Promise<DailyActionOutcome> {
    const progress = await this.get<any>(`${LIVE}/xlive/app-ucenter/v1/userTask/GetUserTaskProgress?${this.appSignedParams({ target_id: 6 })}`, 'https://live.bilibili.com');
    if (!progress.ok) return { result: progress.result };
    const tasks = Array.isArray(progress.data?.task_list) ? progress.data.task_list : [];
    const details: DailyActionDetail[] = [];
    for (const task of tasks.slice(0, this.config.resourceTasks.dailyBatteryMaxActions)) {
      const taskId = Number(task.task_id); if (!taskId) continue;
      if (Number(task.status) === 3 || Number(task.total_reward) === Number(task.received_reward)) { details.push({ targetId: String(taskId), result: { status: 'completed', reason: `${clean(task.task_title || taskId, 80)}已完成` } }); continue; }
      if (Number(task.status) === 2) {
        const claim = await this.postForm<any>(`${LIVE}/xlive/app-ucenter/v1/userTask/UserTaskReceiveRewards`, { target_id: 6, task_id: taskId, csrf: this.csrf, reward_index: 1 }, 'https://live.bilibili.com');
        details.push({ targetId: String(taskId), result: claim.ok ? { status: 'success', reason: `${clean(task.task_title || taskId, 80)}奖励领取成功`, providerCode: 0, attempts: claim.result.attempts } : claim.result });
        continue;
      }
      const room = this.config.resourceTasks.dailyBatteryRoomIds[details.length % Math.max(1, this.config.resourceTasks.dailyBatteryRoomIds.length)];
      if (!room) { details.push({ targetId: String(taskId), result: { status: 'skipped', reason: `${clean(task.task_title || taskId, 80)}需要直播间，当前未配置` } }); continue; }
      const ticker = await this.get<any>(`${LIVE}/xlive/app-ucenter/v1/userTask/UserTaskTickerUpload?${this.appSignedParams({ target_id: room, task_id: taskId })}`, 'https://live.bilibili.com', `https://live.bilibili.com/${room}`);
      details.push({ targetId: String(taskId), result: ticker.ok ? { status: 'success', reason: `${clean(task.task_title || taskId, 80)}进度已上报`, providerCode: 0, attempts: ticker.result.attempts } : ticker.result });
    }
    return this.outcome('每日电池任务', details);
  }

  async activityLottery(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const details: DailyActionDetail[] = []; let draws = 0;
    for (const sid of this.config.community.activityIds) {
      if (draws >= this.config.community.activityMaxDraws) break;
      const times = await this.get<any>(`${API}/x/lottery/mytimes?sid=${encodeURIComponent(sid)}`);
      if (!times.ok) { details.push({ targetId: sid, result: times.result }); continue; }
      const count = Math.min(Number(times.data?.times || 0), this.config.community.activityMaxDraws - draws);
      if (!count) { details.push({ targetId: sid, result: { status: 'completed', reason: `活动 ${sid} 没有剩余抽奖次数` } }); continue; }
      const draw = await this.postForm<any>(`${API}/x/lottery/do`, { sid, num: count, csrf: this.csrf });
      details.push({ targetId: sid, result: draw.ok ? { status: 'success', reason: `活动 ${sid} 已抽奖 ${count} 次`, providerCode: 0, attempts: draw.result.attempts } : draw.result });
      if (draw.ok) draws += count;
    }
    return this.outcome('活动转盘', details);
  }

  async matchGuess(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const nav = await this.nav(); if (!nav.ok) return { result: nav.result };
    const cfg = this.config.community; let balance = Number(nav.data!.money || 0); const details: DailyActionDetail[] = [];
    const collection = await this.get<any>(`${API}/x/esports/guess/collection/question?pn=1&ps=50&gid=&sids=&stime=&etime=`);
    if (!collection.ok) return { result: collection.result };
    const matches = Array.isArray(collection.data?.list) ? collection.data.list : [];
    for (const item of matches) for (const question of Array.isArray(item.questions) ? item.questions : []) {
      if (details.length >= cfg.matchMax || balance - cfg.matchCoins < this.config.experience.protectedCoins || question.is_guess) break;
      const teams = Array.isArray(question.details) ? question.details : []; if (teams.length < 2) continue;
      const sorted = [...teams].sort((a, b) => Number(a.odds) - Number(b.odds));
      if (Math.abs(Number(teams[0].odds) - Number(teams[1].odds)) < cfg.matchMinOddsDiff) continue;
      const choice = sorted[0];
      const reply = await this.postForm<any>(`${API}/x/esports/guess/add`, { is_fav: 0, main_id: Number(question.id), oid: Number(item.contest?.id), detail_id: Number(choice.detail_id), count: cfg.matchCoins, csrf: this.csrf, csrf_token: this.csrf });
      details.push({ targetId: String(question.id), result: reply.ok ? { status: 'success', reason: `赛事竞猜已选择 ${clean(choice.option || choice.detail_id, 80)}，投入 ${cfg.matchCoins} 硬币`, providerCode: 0, attempts: reply.result.attempts } : reply.result });
      if (reply.ok) balance -= cfg.matchCoins;
      if (this.config.requestDelay) await sleep(this.config.requestDelay);
    }
    return this.outcome('赛事竞猜', details);
  }

  async juryVote(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const status = await this.get<any>(`${API}/x/credit/v2/jury/jury`, 'https://www.bilibili.com', 'https://www.bilibili.com/judgement/index');
    if (!status.ok && (status.result.providerCode === 25006 || /资格已过期|不是风纪委员/.test(status.result.providerMessage || status.result.reason || ''))) {
      return { result: { status: 'skipped', reason: `风纪委员资格不可用：${status.result.providerMessage || status.result.reason || '无需执行社区众议院'}` } };
    }
    if (!status.ok) return { result: status.result };
    if (!status.data?.status && this.config.community.juryAutoApply) {
      const apply = await this.postForm<any>(`${API}/x/credit/v2/jury/apply`, { csrf: this.csrf });
      if (!apply.ok) return { result: apply.result };
    } else if (!status.data?.status) return { result: { status: 'skipped', reason: '当前账号不是风纪委员，且未启用自动申请' } };
    const details: DailyActionDetail[] = [];
    for (let index = 0; index < this.config.community.juryMaxCases; index += 1) {
      const next = await this.get<any>(`${API}/x/credit/v2/jury/case/next?csrf=${encodeURIComponent(this.csrf)}`, 'https://www.bilibili.com', 'https://www.bilibili.com/judgement/index');
      if (!next.ok) { details.push({ targetId: String(index + 1), result: next.result }); break; }
      const caseId = String(next.data?.case_id || next.data?.caseId || ''); if (!caseId) break;
      const opinions = await this.get<any>(`${API}/x/credit/v2/jury/case/opinion?case_id=${encodeURIComponent(caseId)}&pn=1&ps=20`, 'https://www.bilibili.com', `https://www.bilibili.com/judgement/case-detail/${caseId}`);
      if (!opinions.ok) { details.push({ targetId: caseId, result: opinions.result }); continue; }
      const list = Array.isArray(opinions.data?.list) ? opinions.data.list : []; const counts = new Map<number, number>();
      for (const item of list) { const vote = Number(item.vote); if (vote > 0) counts.set(vote, (counts.get(vote) || 0) + Math.max(1, Number(item.likes || item.agree || 1))); }
      const vote = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!vote) { details.push({ targetId: caseId, result: { status: 'skipped', reason: '案件没有可用于安全决策的公开观点，未自动投票' } }); continue; }
      const reply = await this.postForm<any>(`${API}/x/credit/v2/jury/vote`, { case_id: caseId, vote, csrf: this.csrf, insiders: 0, anonymous: 1 }, 'https://www.bilibili.com', `https://www.bilibili.com/judgement/case-detail/${caseId}`);
      details.push({ targetId: caseId, result: reply.ok ? { status: 'success', reason: `案件 ${caseId} 已按多数公开观点投票`, providerCode: 0, attempts: reply.result.attempts } : reply.result });
    }
    return this.outcome('社区众议院', details);
  }

  async liveReservation(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const cfg = this.config.community; const reservations = new Map<string, string>();
    for (const sid of cfg.reservationIds) reservations.set(sid, '本地配置');
    for (const uid of cfg.reservationUids) {
      const reply = await this.get<any>(`${API}/x/space/reservation?vmid=${encodeURIComponent(uid)}`, 'https://space.bilibili.com', `https://space.bilibili.com/${uid}/`);
      if (!reply.ok) continue;
      const walk = (value: any) => { if (!value || typeof value !== 'object') return; if (value.sid || value.reserve_id) reservations.set(String(value.sid || value.reserve_id), uid); for (const child of Object.values(value)) if (typeof child === 'object') walk(child); }; walk(reply.data);
    }
    const details: DailyActionDetail[] = [];
    for (const [sid, uid] of [...reservations].slice(0, cfg.reservationMax)) {
      const reply = await this.postForm<any>(`${API}/x/space/reserve`, { sid, csrf: this.csrf, jsonp: 'jsonp' }, 'https://space.bilibili.com', uid === '本地配置' ? 'https://space.bilibili.com/' : `https://space.bilibili.com/${uid}/`);
      details.push({ targetId: sid, result: reply.ok ? { status: 'success', reason: `预约 ${sid} 成功`, providerCode: 0, attempts: reply.result.attempts } : reply.result });
      if (this.config.requestDelay) await sleep(this.config.requestDelay);
    }
    return this.outcome('直播预约', details);
  }

  async blacklistCleanup(): Promise<DailyActionOutcome> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const details: DailyActionDetail[] = []; let page = 1;
    while (details.length < this.config.community.blacklistMax && page <= 20) {
      const reply = await this.get<any>(`${API}/x/relation/blacks?re_version=0&pn=${page}&ps=20&jsonp=jsonp&web_location=0.0`);
      if (!reply.ok) return details.length ? this.outcome('黑名单清理', [...details, { targetId: `page-${page}`, result: reply.result }]) : { result: reply.result };
      const list = Array.isArray(reply.data?.list) ? reply.data.list : [];
      for (const item of list.filter((value: any) => value.uname === '账号已注销')) {
        if (details.length >= this.config.community.blacklistMax) break;
        const mid = String(item.mid || ''); const remove = await this.postForm<any>(`${API}/x/relation/modify`, { fid: mid, act: 6, re_src: 11, csrf: this.csrf });
        details.push({ targetId: mid, result: remove.ok ? { status: 'success', reason: `已移除注销账号 ${mid} 的黑名单关系`, providerCode: 0, attempts: remove.result.attempts } : remove.result });
        if (this.config.requestDelay) await sleep(this.config.requestDelay);
      }
      if (list.length < 20) break; page += 1;
    }
    return this.outcome('黑名单清理', details);
  }

  private liveHeartbeatSign(params: Record<string, unknown>) {
    const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)])) : typeof value === 'number' ? String(value) : value;
    let value = JSON.stringify(normalize(params));
    for (const algorithm of ['sha512', 'sha3-512', 'sha384', 'sha3-384', 'blake2b512']) value = createHash(algorithm).update(value).digest('hex');
    return value;
  }

  async runLiveAutomation(signal: AbortSignal, report: (action: string, targetId: string, result: DailyResult) => void | Promise<void>) {
    const cfg = this.config.liveAutomation; const csrfError = this.requireCsrf(); if (csrfError) throw new Error(csrfError.reason);
    if (!cfg.enabled) return { status: 'completed', reason: '长运行直播任务未启用' } as DailyResult;
    const rooms = cfg.rooms.length ? cfg.rooms : await this.discoverLiveRooms(report);
    if (!rooms.length) return { status: 'skipped', reason: '未配置直播间，且当前账号没有发现正在直播的关注 UP 主' } as DailyResult;
    const deadline = Date.now() + cfg.durationMinutes * 60000; let redCount = 0; let danmakuCount = 0; let cycle = 0;
    liveLoop: while (!signal.aborted && Date.now() < deadline) {
      for (const roomId of rooms) {
        if (signal.aborted || Date.now() >= deadline) break;
        const info = await this.get<any>(`${LIVE}/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}&from=room`, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
        if (!info.ok) { await report('live_room_check', roomId, info.result); if (info.result.status === 'throttled') break liveLoop; continue; }
        const upId = String(info.data?.uid || '');
        if (cfg.intimacy && cycle === 0) {
          const like = await this.postForm<any>(`${LIVE}/xlive/web-ucenter/v1/interact/likeInteract`, { roomid: roomId, csrf: this.csrf, csrf_token: this.csrf }, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
          await report('live_intimacy', roomId, like.ok ? { status: 'success', reason: '直播间点赞成功', providerCode: 0, attempts: like.result.attempts } : like.result);
          const share = await this.postForm<any>(`${LIVE}/xlive/web-room/v1/index/TrigerInteract`, { roomid: roomId, interact_type: 3, csrf: this.csrf, csrf_token: this.csrf, visit_id: '' }, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
          await report('live_intimacy', `${roomId}:share`, share.ok ? { status: 'success', reason: '直播间分享任务成功', providerCode: 0, attempts: share.result.attempts } : share.result);
        }
        if (cfg.danmaku && danmakuCount < cfg.maxDanmaku && cycle === 0) {
          const message = cfg.messages[danmakuCount % Math.max(1, cfg.messages.length)] || '打卡';
          const dm = await this.postForm<any>(`${LIVE}/msg/send`, { bubble: 0, msg: message.slice(0, 20), color: 5566168, mode: 1, fontsize: 25, rnd: Math.floor(Date.now() / 1000), roomid: roomId, csrf: this.csrf, csrf_token: this.csrf }, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
          await report('live_danmaku', roomId, dm.ok ? { status: 'success', reason: `直播弹幕已发送：${message.slice(0, 20)}`, providerCode: 0, attempts: dm.result.attempts } : dm.result); danmakuCount += 1;
        }
        if (cfg.redPackets && redCount < cfg.maxRedPackets) {
          const packets = await this.get<any>(`${LIVE}/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?roomid=${encodeURIComponent(roomId)}`, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
          if (!packets.ok) await report('live_red_packet', roomId, packets.result);
          else {
            const found: any[] = []; const walk = (value: any) => { if (!value || typeof value !== 'object') return; if ((value.lot_id || value.lottery_id) && (value.room_id || roomId)) found.push(value); for (const child of Object.values(value)) if (typeof child === 'object') walk(child); }; walk(packets.data);
            for (const packet of found) {
              if (redCount >= cfg.maxRedPackets) break;
              const lotId = String(packet.lot_id || packet.lottery_id); const join = await this.postJson<any>(`${LIVE}/xlive/lottery-interface/v1/popularityRedPocket/RedPocketDraw`, { room_id: Number(packet.room_id || roomId), ruid: Number(packet.ruid || upId), lot_id: Number(lotId), spm_id: '444.8.red_envelope.extract', jump_from: '26000', c_locale: 'zh_CN', device: 'android', mobi_app: 'android', platform: 'android', channel: 'xiaomi', version: '6.79.0', statistics: { appId: 1, platform: 3, version: '6.79.0', abtest: '' }, session_id: '', csrf_token: this.csrf, csrf: this.csrf, build: 6790300, visit_id: '' }, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
              await report('live_red_packet', `${roomId}:${lotId}`, join.ok ? { status: 'success', reason: `直播红包 ${lotId} 已参与`, providerCode: 0, attempts: join.result.attempts } : join.result); if (join.ok) redCount += 1;
            }
          }
        }
        if (cfg.heartbeat && upId) {
          const now = Math.floor(Date.now() / 1000); const base: Record<string, any> = { platform: 'android', uuid: randomBytes(16).toString('hex'), buvid: `XX${randomBytes(16).toString('hex').toUpperCase()}`, seq_id: cycle + 1, room_id: Number(roomId) || 0, parent_id: Number(info.data?.parent_area_id || 0), area_id: Number(info.data?.area_id || 0), timestamp: now - 60, secret_key: 'axoaadsffcazxksectbbb', watch_time: 60, up_id: Number(upId) || 0, up_level: 40, jump_from: 30000, gu_id: randomBytes(22).toString('hex').toUpperCase(), play_type: 0, play_url: '', s_time: 0, data_behavior_id: '', data_source_id: '', up_session: '', visit_id: randomBytes(16).toString('hex'), watch_status: '', click_id: '', session_id: -99998, player_type: 0, client_ts: now };
          const heartbeat = await this.postJson<any>(`https://live-trace.bilibili.com/xlive/data-interface/v1/heartbeat/mobileHeartBeat`, { ...base, ts: now, client_sign: this.liveHeartbeatSign(base), mobi_app: 'android', channel: 'xiaomi_cn_tv.danmaku.bili_20210930', c_locale: 'zh_CN', device: 'android', build: 6790300, csrf_token: this.csrf, csrf: this.csrf, disable_rcmd: '0' }, 'https://live.bilibili.com', `https://live.bilibili.com/${roomId}`);
          await report('live_heartbeat', roomId, heartbeat.ok ? { status: 'success', reason: `第 ${cycle + 1} 次直播心跳成功`, providerCode: 0, attempts: heartbeat.result.attempts } : heartbeat.result);
        }
      }
      cycle += 1; if (signal.aborted || Date.now() >= deadline) break;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 60000); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
    if (signal.aborted) return { status: 'skipped', reason: '长运行直播任务已取消' } as DailyResult;
    if (this.riskPauseReason) return { status: 'throttled', reason: `长运行直播任务已暂停：${this.riskPauseReason}` } as DailyResult;
    return { status: 'success', reason: `长运行直播任务已完成 ${cycle} 轮` } as DailyResult;
  }

  private async discoverLiveRooms(report: (action: string, targetId: string, result: DailyResult) => void | Promise<void>) {
    const discovered = new Set<string>();
    const pageSize = 50;
    for (let page = 1; page <= 3; page += 1) {
      const reply = await this.get<any>(`${LIVE}/xlive/web-ucenter/user/following?page=${page}&page_size=${pageSize}`, 'https://live.bilibili.com', 'https://live.bilibili.com/');
      if (!reply.ok) {
        await report('live_room_discovery', '', reply.result);
        return [...discovered];
      }
      const list = Array.isArray(reply.data?.list) ? reply.data.list : [];
      for (const room of list) {
        const roomId = String(room.roomid || '');
        if (roomId && Number(room.live_status) === 1) discovered.add(roomId);
      }
      const totalPage = Math.max(1, Number(reply.data?.totalPage) || 1);
      if (page >= totalPage || list.length === 0) break;
    }
    const followedCount = discovered.size;
    const index = await this.get<any>(`${LIVE}/xlive/web-interface/v1/index/getList?platform=web`, 'https://live.bilibili.com', 'https://live.bilibili.com/');
    if (index.ok) {
      const groups = Array.isArray(index.data?.room_list) ? index.data.room_list : [];
      for (const group of groups) for (const room of Array.isArray(group?.list) ? group.list : []) {
        if (room?.is_ad) continue;
        const roomId = String(room?.roomid || '');
        if (roomId) discovered.add(roomId);
        if (discovered.size >= 20) break;
      }
    } else {
      await report('live_room_discovery', '', index.result);
    }
    const rooms = [...discovered].slice(0, 20);
    const sourceText = followedCount ? `其中关注房间 ${followedCount} 个` : '未发现关注房间';
    await report('live_room_discovery', '', rooms.length ? { status: 'success', reason: `自动发现 ${rooms.length} 个直播间（${sourceText}，允许陌生直播间）`, providerCode: 0 } : { status: 'skipped', reason: '关注列表和直播首页都未发现可用直播间', providerCode: 0 });
    return rooms;
  }

  async prepareStream(): Promise<{ roomId?: number; pushUrl?: string; result: DailyResult }> {
    const csrfError = this.requireCsrf(); if (csrfError) return { result: csrfError };
    const liveInfo = await this.get<any>(`${LIVE}/xlive/web-ucenter/user/live_info`, 'https://link.bilibili.com');
    if (!liveInfo.ok) return { result: liveInfo.result };
    const roomId = Number(liveInfo.data?.room_id || 0); if (!roomId) return { result: failure('当前账号没有可用直播间', { errorType: 'local' }) };
    if (this.config.streaming.title) {
      const title = await this.postForm<any>(`${LIVE}/room/v1/Room/update`, { room_id: roomId, title: this.config.streaming.title, csrf: this.csrf, csrf_token: this.csrf }, 'https://link.bilibili.com');
      if (!title.ok) return { roomId, result: title.result };
    }
    const area = await this.postForm<any>(`${LIVE}/room/v1/Room/update`, { room_id: roomId, area_id: this.config.streaming.areaId, csrf: this.csrf, csrf_token: this.csrf }, 'https://link.bilibili.com');
    if (!area.ok) return { roomId, result: area.result };
    const stream = await this.postForm<any>(`${LIVE}/xlive/app-blink/v1/live/FetchWebUpStreamAddr`, { platform: 'pc', csrf: this.csrf, csrf_token: this.csrf }, 'https://link.bilibili.com');
    if (!stream.ok) return { roomId, result: stream.result };
    const address = stream.data?.addr?.addr; const code = stream.data?.addr?.code;
    if (!address || !code) return { roomId, result: failure('推流地址响应格式异常', { errorType: 'parse' }) };
    const start = await this.postForm<any>(`${LIVE}/room/v1/Room/startLive`, { platform: 'pc', room_id: roomId, area_v2: this.config.streaming.areaId, csrf: this.csrf, csrf_token: this.csrf }, 'https://link.bilibili.com');
    if (!start.ok) return { roomId, result: start.result };
    return { roomId, pushUrl: `${address}${code}`, result: { status: 'success', reason: '直播间已开始推流', providerCode: 0, attempts: start.result.attempts } };
  }

  async stopStream(roomId: number): Promise<DailyResult> {
    const reply = await this.postForm<any>(`${LIVE}/room/v1/Room/stopLive`, { platform: 'pc', room_id: roomId, csrf: this.csrf, csrf_token: this.csrf }, 'https://link.bilibili.com');
    return reply.ok ? { status: 'success', reason: '直播间已停止', providerCode: 0, attempts: reply.result.attempts } : reply.result;
  }
}
