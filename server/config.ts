import { createRequire } from 'node:module';
import type { AiConfig } from './ai';

const require = createRequire(import.meta.url);
const example = require('../my_config.example.js');

export type ConfigFieldType = 'boolean' | 'number' | 'text' | 'textarea' | 'string-list' | 'number-list' | 'select' | 'mode' | 'json';
export type ConfigField = {
  key: string; category: string; label: string; description?: string; type: ConfigFieldType;
  unit?: string; min?: number; max?: number; step?: number; nullable?: boolean; readOnly?: boolean;
  options?: Array<{ value: string | number; label: string }>;
};

export const defaultConfig: Record<string, any> = example.default_config || {};

export const configCategories = [
  { id: 'sources', label: '抽奖来源', description: '设置从哪些位置发现抽奖动态，以及各来源的执行顺序。' },
  { id: 'rules', label: '筛选与参与规则', description: '控制动态筛选范围、参与类型和重复检查方式。' },
  { id: 'actions', label: '评论、转发与关注', description: '设置参与抽奖时使用的评论、转发和关注策略。' },
  { id: 'scan', label: '扫描范围', description: '限制各类来源的扫描页数和内容时间范围。' },
  { id: 'intervals', label: '请求与操作间隔', description: '控制请求频率，单位均为毫秒。' },
  { id: 'random', label: '随机动态', description: '配置用于降低抽奖号特征的随机动态。' },
  { id: 'winning', label: '中奖检测', description: '设置中奖关键词和私信扫描范围。' },
  { id: 'cleanup', label: '清理设置', description: '配置历史动态和临时关注的清理规则。' },
  { id: 'advanced', label: '高级兼容设置', description: '保留原 CLI 的高级字段；运行状态字段仅供查看。' }
];

const number = (key: string, category: string, label: string, description: string, min: number, max: number, unit?: string, nullable = false): ConfigField => ({ key, category, label, description, type: 'number', min, max, unit, nullable });
const toggle = (key: string, category: string, label: string, description: string): ConfigField => ({ key, category, label, description, type: 'boolean' });
const list = (key: string, category: string, label: string, description: string, numeric = false): ConfigField => ({ key, category, label, description, type: numeric ? 'number-list' : 'string-list' });

export const configFields: ConfigField[] = [
  list('UIDs', 'sources', '监控用户 UID', '每行一个 UID，扫描指定用户发布的动态。', true),
  list('TAGs', 'sources', '监控话题', '每行一个话题名称，不需要输入 #。'),
  list('Articles', 'sources', '专栏关键词', '每行一个专栏搜索关键词。'),
  list('ArticleUIDs', 'sources', '抽奖合集账号 UID', '读取这些账号最新专栏中引用的动态。', true),
  { key: 'FollowFeed', category: 'sources', label: '关注动态流', description: '关闭后不扫描当前账号的关注动态；开启时设置扫描页数。', type: 'number', min: 1, max: 20, unit: '页', nullable: true },
  list('APIs', 'sources', '外部 API 地址', '每行一个 HTTP(S) API，返回 lottery_info 数组。'),
  list('TxT', 'sources', '本地动态 ID 文件', '每行一个文件名，兼容原 CLI 文本来源。'),
  { key: 'LotteryOrder', category: 'sources', label: '来源执行顺序', description: '使用上下按钮调整顺序；关闭的来源不会执行。', type: 'json' },
  toggle('save_lottery_info_to_file', 'sources', '保存发现结果到文件', '保留原 CLI 的抽奖信息文件输出。'),
  { key: 'set_lottery_info_url', category: 'sources', label: '抽奖信息上传地址', description: '留空表示不上传。', type: 'text' },

  list('key_words', 'rules', '抽奖关键词规则', '每行一条正则规则，动态需同时满足。'),
  { key: 'model', category: 'rules', label: '自动参与范围', description: '分别控制官方与非官方抽奖是否参与。', type: 'mode' },
  { key: 'chatmodel', category: 'rules', label: '自动评论范围', description: '网站管理的账号固定对官方和非官方抽奖发表评论。', type: 'mode', readOnly: true },
  toggle('disable_reserve_lottery', 'rules', '不参与预约抽奖', '开启后跳过所有预约抽奖。'),
  toggle('is_not_relay_reserve_lottery', 'rules', '预约抽奖不转发关注', '预约抽奖可能与转发抽奖同时存在。'),
  { key: 'check_if_duplicated', category: 'rules', label: '重复参与检查', description: '选择判断是否已经参与的方法。', type: 'select', options: [
    { value: -1, label: '不检查' }, { value: 0, label: '按点赞判断并自动点赞' }, { value: 1, label: '检查本地参与记录' }, { value: 2, label: '按点赞判断且不点赞，并检查本地记录' }, { value: 3, label: '按点赞判断并点赞，同时检查本地记录' }
  ] },
  toggle('sneaktower', 'rules', '偷塔模式', '临近开奖时参与，不执行常规重复转发检查。'),
  list('block_dynamic_type', 'rules', '屏蔽动态类型', '动态类型编号，每行一个。', true),
  number('max_create_time', 'rules', '动态发布时间范围', '只处理最近指定天数内发布的动态。', 0, 3650, '天'),
  number('maxday', 'rules', '开奖时间范围', '只参与未来指定天数内开奖的动态。', 0, 3650, '天', true),
  number('minfollower', 'rules', '发起人最低粉丝数', '低于该粉丝数的非官方抽奖将被过滤。', 0, 100000000, '人'),
  toggle('only_followed', 'rules', '只参与已关注账号', '只处理当前已关注用户发起的抽奖。'),
  { key: 'blacklist', category: 'rules', label: '黑名单', description: '动态 ID 或 UID，使用英文逗号分隔。', type: 'textarea' },
  list('blocked_lottery_uids', 'rules', '屏蔽抽奖发起人 UID', '仅匹配抽奖实际发起人，不匹配转发者、动态 ID 或旧黑名单规则。', true),
  list('blockword', 'rules', '屏蔽词', '正文命中任一词时不参与。'),
  { key: 'blockword_match_mode', category: 'rules', label: '屏蔽词匹配模式', description: '普通文字模式按原文包含匹配；正则模式兼容原有正则表达式配置。', type: 'select', options: [{ value: 'literal', label: '普通文字（推荐）' }, { value: 'regex', label: '正则表达式' }] },

  toggle('is_imitator', 'actions', '监控 UID 直接转发', '对监控 UID 转发的动态不执行关键词判断。'),
  toggle('is_repost_then_chat', 'actions', '转发后使用相同内容评论', '转发附言也会作为评论内容。'),
  list('relay', 'actions', '固定转发文案', 'AI 不可用或未启用时随机选择。'),
  list('chat', 'actions', '固定评论文案', 'AI 不可用或未启用时随机选择。'),
  toggle('is_copy_chat', 'actions', '复制热门评论', '从动态热门评论中选择可用文案。'),
  toggle('copy_chat_on_ai_failure', 'actions', 'AI 评论失败时复制评论', 'AI 未启用、失败或返回空内容时，复制当前动态评论区；无可用评论时再回退备用和固定文案。'),
  list('copy_blockword', 'actions', '热门评论屏蔽词', '热门评论命中任一词时不使用。'),
  { key: 'at_users', category: 'actions', label: '@ 用户列表', description: '二维数组格式：[名称, UID]。', type: 'json' },
  number('partition_id', 'actions', '临时关注分组 ID', 'B 站关注分组的数字 ID，0 表示自动获取。', 0, 999999999),
  toggle('is_not_create_partition', 'actions', '不创建临时关注分组', '开启后不为抽奖账号单独创建关注分组。'),

  number('uid_scan_page', 'scan', '用户动态扫描页数', '每个 UID 最多扫描的页数。', 1, 50, '页'),
  number('tag_scan_page', 'scan', '话题扫描页数', '每个话题最多扫描的页数。', 1, 50, '页'),
  number('article_scan_page', 'scan', '专栏扫描数量', '每个关键词最多读取的专栏数量。', 1, 100, '篇'),
  number('article_create_time', 'scan', '专栏发布时间范围', '只读取最近指定天数的专栏。', 0, 3650, '天'),
  toggle('not_check_article', 'scan', '不检查专栏历史', '开启后不检查专栏是否已经处理过。'),

  number('lottery_loop_wait', 'intervals', '抽奖循环等待', '所有抽奖操作结束后的等待时间，0 表示不循环。', 0, 86400000, '毫秒'),
  number('check_loop_wait', 'intervals', '中奖检测循环等待', '中奖检测结束后的等待时间，0 表示不循环。', 0, 86400000, '毫秒'),
  number('clear_loop_wait', 'intervals', '清理循环等待', '清理结束后的等待时间，0 表示不循环。', 0, 86400000, '毫秒'),
  number('wait', 'intervals', '转发操作间隔', '实际间隔会在该值附近随机浮动。', 0, 600000, '毫秒'),
  number('search_wait', 'intervals', '动态检索间隔', '读取不同动态之间的等待时间。', 0, 600000, '毫秒'),
  number('get_session_wait', 'intervals', '私信翻页间隔', '读取下一页私信前的等待时间。', 0, 600000, '毫秒'),
  number('update_session_wait', 'intervals', '私信已读间隔', '更新私信已读状态之间的等待时间。', 0, 600000, '毫秒'),
  number('get_partition_wait', 'intervals', '关注列表翻页间隔', '读取下一页关注列表前的等待时间。', 0, 600000, '毫秒'),
  number('get_dynamic_detail_wait', 'intervals', '动态详情间隔', '读取动态详情之间的等待时间。', 0, 600000, '毫秒'),
  number('filter_wait', 'intervals', '筛选请求间隔', '查询开奖时间或粉丝数之间的等待时间。', 0, 600000, '毫秒'),
  number('random_dynamic_wait', 'intervals', '随机动态间隔', '发送随机动态之间的等待时间。', 0, 600000, '毫秒'),
  number('reserve_lottery_wait', 'intervals', '预约抽奖间隔', '执行预约操作之间的等待时间。', 0, 600000, '毫秒'),

  toggle('create_dy', 'random', '发送随机动态', '在抽奖过程中穿插普通动态。'),
  { key: 'create_dy_type', category: 'random', label: '随机动态类型', description: '选择发送自定义内容、推荐视频或混合。', type: 'select', options: [{ value: 0, label: '自定义文字与图片' }, { value: 1, label: '推荐视频' }, { value: -1, label: '混合' }] },
  number('create_dy_num', 'random', '结束时发送数量', '任务结束时发送的随机动态数量。', 0, 100, '条'),
  { key: 'dy_contents', category: 'random', label: '随机动态内容', description: '普通文本或图片对象数组；可在高级 JSON 中精确调整。', type: 'json' },
  { key: 'create_dy_mode', category: 'random', label: '随机动态插入规则', description: '二维数组，分别表示触发条数和发送条数。', type: 'json' },
  number('share_video_every_forwards', 'random', '每成功转发多少条触发分享', '只统计转发状态为成功的抽奖动态；0 表示关闭。推荐视频附言优先使用账号的 AI 转发配置。', 0, 100, '条'),
  number('share_video_count_per_trigger', 'random', '每次触发分享视频数', '达到上方成功转发数量时立即分享的推荐视频数；0 表示不分享。附言会经过敏感词和 233 字安全校验。', 0, 20, '个'),
  number('share_video_after_run', 'random', '任务结束分享视频数', '全部抽奖处理正常结束后分享的推荐视频数；0 表示关闭。AI 不可用时会使用备用或固定转发文案。', 0, 20, '个'),

  list('notice_key_words', 'winning', '中奖通知关键词', '满足任一规则时生成疑似中奖记录；~ 开头表示排除规则。'),
  toggle('notice_running_state', 'winning', '发送运行状态通知', '保留原 CLI 的运行状态通知。'),
  number('check_session_pages', 'winning', '私信扫描页数', '每次中奖检测最多读取的私信页数。', 1, 100, '页'),

  { key: 'clear_white_list', category: 'cleanup', label: '清理白名单', description: 'UID 或动态 ID，使用英文逗号分隔。', type: 'textarea' },
  { key: 'clear_partition', category: 'cleanup', label: '抽奖关注分组', description: '只会从这些 B 站关注分组中取消关注，可使用英文逗号分隔多个分组名称。', type: 'text' },
  number('clear_max_day', 'cleanup', '推定开奖天数', '账号转发动态发布后经过这些天数，推定为已经开奖并允许清理。', 1, 3650, '天'),
  toggle('clear_remove_dynamic', 'cleanup', '删除过期转发动态', '删除超过推定开奖天数的账号转发动态。'),
  toggle('clear_remove_attention', 'cleanup', '取消无进行中抽奖的关注', '仅处理抽奖关注分组中、已无进行中参与动态的 UP 主。'),
  number('clear_remove_delay', 'cleanup', '清理操作间隔', '每次删除或取关之间的等待时间。', 0, 600000, '毫秒'),
  list('clear_dynamic_type', 'cleanup', '清理动态类型', '默认仅清理类型 1（转发动态）；网页清理页面不会删除原创动态。', true),

  { key: 'is_exception', category: 'advanced', label: '运行异常标记', description: '由运行时维护，不建议手动修改。', type: 'boolean', readOnly: true },
  { key: 'is_outof_maxfollow', category: 'advanced', label: '关注已达上限', description: '由运行时维护，不建议手动修改。', type: 'boolean', readOnly: true }
];

const unlimitedKeys = new Set(['maxday', 'clear_quick_remove_attention_fans_number_smallest']);
const internalKeys = new Set(['ai_judge_parm', 'ai_comments_parm', 'ai_relay_parm']);
const fieldMap = new Map(configFields.map(field => [field.key, field]));

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clone(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}

function jsonEqual(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }

export function toWebConfig(value: Record<string, unknown>) {
  const convert = (item: unknown): unknown => {
    if (item === Infinity || item === -Infinity) return null;
    if (Array.isArray(item)) return item.map(convert);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, convert(child)]));
    return item;
  };
  return convert(value) as Record<string, unknown>;
}

export function toRuntimeConfig(value: Record<string, unknown>) {
  const result = clone(value) as Record<string, any>;
  for (const key of unlimitedKeys) if (result[key] === null || result[key] === undefined) result[key] = Infinity;
  if (result.FollowFeed === null || result.FollowFeed === false) result.FollowFeed = [];
  else if (typeof result.FollowFeed === 'number') result.FollowFeed = [result.FollowFeed];
  return result;
}

function businessConfig(value: Record<string, unknown> = {}) {
  const result = clone(value) as Record<string, unknown>;
  delete result.ai;
  return result;
}

export function mergedConfig(override: Record<string, unknown> = {}, inherited: Record<string, unknown> = {}) {
  return toRuntimeConfig({ ...clone(defaultConfig), ...businessConfig(inherited), ...businessConfig(override), chatmodel: '11' });
}

function sanitizeField(field: ConfigField, value: unknown) {
  if (field.readOnly) return clone(defaultConfig[field.key]);
  if (field.nullable && value === null) return null;
  if (field.key === 'FollowFeed') {
    if (value === null || value === false || (Array.isArray(value) && value.length === 0)) return null;
    const page = Array.isArray(value) ? Number(value[0]) : Number(value);
    if (!Number.isFinite(page) || page < 1 || page > 20) throw new Error('关注动态流扫描页数必须在 1 到 20 之间');
    return [Math.round(page)];
  }
  if (field.type === 'boolean') return Boolean(value);
  if (field.type === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${field.label}必须是有效数字`);
    if (field.min !== undefined && parsed < field.min) throw new Error(`${field.label}不能小于 ${field.min}`);
    if (field.max !== undefined && parsed > field.max) throw new Error(`${field.label}不能大于 ${field.max}`);
    return parsed;
  }
  if (field.type === 'number-list') {
    if (!Array.isArray(value)) throw new Error(`${field.label}必须是数组`);
    if (field.key === 'blocked_lottery_uids') {
      const normalized: number[] = [];
      const seen = new Set<number>();
      for (const item of value) {
        const uid = Number(item);
        if (!Number.isSafeInteger(uid) || uid <= 0 || seen.has(uid)) continue;
        seen.add(uid);
        normalized.push(uid);
      }
      return normalized;
    }
    const values = value.map(item => Number(item));
    if (values.some(item => !Number.isFinite(item) || item < 0)) throw new Error(`${field.label}包含无效数字`);
    return values;
  }
  if (field.type === 'string-list') {
    if (!Array.isArray(value)) throw new Error(`${field.label}必须是数组`);
    const values = value.map(item => String(item).trim()).filter(Boolean);
    if (field.key === 'APIs' && values.some(item => !/^(https?:\/\/|file:\/\/)/i.test(item))) throw new Error('外部 API 地址必须使用 HTTP(S) 或 file://');
    return values;
  }
  if (field.type === 'mode') {
    const mode = String(value);
    if (!/^[01]{2}$/.test(mode)) throw new Error(`${field.label}配置无效`);
    return mode;
  }
  if (field.type === 'select') {
    const allowed = field.options?.map(option => option.value) || [];
    const normalized = typeof allowed[0] === 'number' ? Number(value) : String(value);
    if (!allowed.includes(normalized)) throw new Error(`${field.label}选项无效`);
    return normalized;
  }
  if (field.type === 'json') {
    if (field.key === 'LotteryOrder') {
      if (!Array.isArray(value) || value.some(item => !Number.isInteger(Number(item)) || Number(item) < 0 || Number(item) > 6)) throw new Error('来源执行顺序必须由 0 到 6 的来源编号组成');
      return value.map(Number);
    }
    return clone(value);
  }
  return String(value ?? '');
}

export function validateWebConfig(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象');
  const source = input as Record<string, unknown>;
  const effective = toWebConfig(defaultConfig);
  for (const [key, value] of Object.entries(source)) {
    if (key === 'ai') continue;
    const field = fieldMap.get(key);
    if (field) effective[key] = sanitizeField(field, value);
    else if (internalKeys.has(key)) continue;
    else effective[key] = clone(value);
  }
  effective.chatmodel = '11';
  const order = effective.LotteryOrder as number[];
  if (!order.length) throw new Error('至少启用一个抽奖来源');
  return effective;
}

export function diffFromDefaults(input: unknown) {
  return diffFromBase(input);
}

export function diffFromBase(input: unknown, inherited: Record<string, unknown> = {}) {
  const effective = validateWebConfig(input);
  const defaults = toWebConfig(mergedConfig({}, inherited));
  const diff: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(effective)) if (!jsonEqual(value, defaults[key])) diff[key] = clone(value);
  return { effective, diff };
}

export function publicConfigPayload(override: Record<string, unknown> = {}, inherited: Record<string, unknown> = {}, scope: 'default' | 'account' = 'account') {
  const businessOverride = businessConfig(override);
  const effective = toWebConfig(mergedConfig(businessOverride, inherited));
  return {
    scope,
    inherited: scope === 'account' && Object.keys(businessOverride).length === 0,
    effective,
    overrides: toWebConfig(businessOverride),
    defaults: toWebConfig(mergedConfig({}, inherited)),
    categories: configCategories,
    fields: configFields
  };
}

export function runtimeConfig(accountId: number, override: Record<string, unknown> = {}, ai?: AiConfig, inherited: Record<string, unknown> = {}) {
  const accountConfig = mergedConfig(override, inherited);
  if (ai) {
    accountConfig.ai_judge_parm = { url: ai.baseUrl, body: { model: ai.model, temperature: ai.temperature, max_tokens: ai.maxTokens }, prompt: ai.judgePrompt };
    accountConfig.ai_comments_parm = { url: ai.baseUrl, body: { model: ai.model, temperature: ai.temperature, max_tokens: ai.maxTokens }, prompt: ai.commentPrompt };
    accountConfig.ai_relay_parm = { url: ai.baseUrl, body: { model: ai.model, temperature: ai.temperature, max_tokens: ai.maxTokens }, prompt: ai.relayPrompt };
  }
  return { default_config: mergedConfig({}, inherited), [`config_${accountId}`]: accountConfig };
}

export function stringifyRuntimeConfig(value: unknown) {
  const marker = '__LOTTERY_INFINITY__';
  return JSON.stringify(value, (_key, item) => item === Infinity ? marker : item, 2).replace(new RegExp(`"${marker}"`, 'g'), 'Infinity');
}
