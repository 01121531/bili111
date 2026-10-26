const { log, hasEnv, shuffle, getRandomOne, getAiContent, delay, try_for_each, appendLotteryInfoFile } = require('../utils');
const { send } = require('../net/http');
const bili = require('../net/bili');
const { sendNotify } = require('../helper/notify');
const event_bus = require('../helper/event_bus');
const { randomDynamic } = require('../helper/randomDynamic');
const { Searcher } = require('./searcher');
const global_var = require('../data/global_var');
const config = require('../data/config');
const d_storage = require('../helper/d_storage');
const { hasFollowing } = require('../net/followings');
const { emitRuntimeEvent } = require('../helper/runtime_event');
const { parseDrawTime, normalizeAiDrawTime } = require('../helper/draw_time');
const { buildComment, configuredComment, fetchCopiedComment } = require('../helper/comment_fallback');
const { findBlockedLotteryUid } = require('../helper/lottery_rules');
const { VideoShareController } = require('../helper/video_share');
const { extractJsonObject } = require('../helper/ai_response');

function renderAiPrompt(template, variables) {
    return String(template || '').replace(/\{(dynamic_text|author|lottery_conditions|draw_time|account_name)\}/g, (_, key) => variables[key] || '');
}

function safeAiText(value, fallback) {
    const text = String(value || '').replace(/```[\s\S]*?```/g, '').trim().slice(0, 500);
    let sensitiveWords = [];
    try { sensitiveWords = JSON.parse(process.env.AI_SENSITIVE_WORDS || '[]'); } catch (_) { /* ignore malformed runtime settings */ }
    if (text && !sensitiveWords.some(word => word && text.includes(word))) return text;
    const backup = String(fallback || '').replace(/```[\s\S]*?```/g, '').trim().slice(0, 500);
    return backup && !sensitiveWords.some(word => word && backup.includes(word)) ? backup : '';
}

const participationReasons = {
    1001: '评论失败：未知错误', 1002: '评论失败：原动态已删除', 1003: '评论失败：评论区已关闭',
    1004: '评论失败：需要输入验证码', 1005: '评论失败：已被对方拉入黑名单', 1006: '评论失败：黑名单用户无法互动',
    1007: '评论失败：UP主已关闭评论区', 1008: '评论失败：内容包含敏感信息', 1009: '评论失败：重复评论',
    1010: '评论失败：账号未登录', 1011: '评论失败：仅限关注七天以上用户',
    1013: '评论失败：账号未转正', 2001: '关注失败：未知错误',
    2002: '关注失败：已被对方拉入黑名单', 2003: '关注失败：黑名单用户无法关注', 2004: '关注失败：账号异常',
    2005: '关注失败：关注数量已达上限', 3001: '关注分组失败', 4001: '点赞失败：未知错误',
    4002: '点赞失败：账号异常', 4003: '点赞失败：操作频繁', 4004: '点赞失败：已经点过赞',
    4005: '点赞失败：账号异常', 5001: '转发失败：未知错误', 5002: '转发失败：动态不能转发',
    5003: '转发失败：请求数据错误', 5004: '转发失败：操作频繁', 5005: '转发失败：源动态禁止转发',
    5006: '转发失败：等级不足无法发送'
};

function participationReason(code) {
    return participationReasons[code] || (code ? `参与失败，状态码 ${code}` : '参与操作完成');
}

async function retryDetailed(maxTimes, retryCodes, fn) {
    let result = null;
    const attempts = [];
    for (let times = 0; times < maxTimes; times += 1) {
        result = await fn();
        for (const attempt of result.attempts || []) attempts.push({ ...attempt, attemptNo: attempts.length + 1 });
        if (result.status === 'challenge' || !(result.retryable || retryCodes.includes(result.internalCode)) || times === maxTimes - 1) break;
        log.warn('自动重试', `将在 ${times + 1} 分钟后再次尝试(${times + 1}/${maxTimes})`);
        await delay(60 * 1000 * (times + 1));
    }
    result.attempts = attempts;
    return result;
}

/**
 * Return the configured blockword expressions that match the current text.
 * Blockwords historically accepted regular expressions, so each expression
 * is tested independently and a malformed one cannot abort the task.
 */
function normalizeBlockwordText(value) {
    return String(value || '').normalize('NFKC').replace(/\u3000/g, ' ');
}

function getBlockwordMatches(blockwords, text, mode = 'literal') {
    const matches = [];
    const seen = new Set();
    const value = normalizeBlockwordText(text);
    for (const rawWord of Array.isArray(blockwords) ? blockwords : []) {
        const word = String(rawWord || '').trim();
        if (!word || seen.has(word)) continue;
        try {
            const match = mode === 'regex' ? value.match(new RegExp(word, 'iu')) : null;
            const literal = mode === 'regex' ? null : normalizeBlockwordText(word);
            const literalIndex = literal ? value.indexOf(literal) : -1;
            if (match || literalIndex >= 0) {
                matches.push({ word, snippet: match ? String(match[0] || word) : value.slice(literalIndex, literalIndex + literal.length) });
                seen.add(word);
            }
        } catch (error) {
            log.warn('筛选动态', `屏蔽词正则无效，已跳过：${word}`);
        }
    }
    return matches;
}

function getMatchedBlockwords(blockwords, text, mode = 'regex') {
    return getBlockwordMatches(blockwords, text, mode).map(item => item.word);
}

function blockwordReason(matches, source = '正文') {
    if (!matches.length) return '正文命中屏蔽词';
    const detailed = matches.map(item => typeof item === 'string' ? { word: item, snippet: item } : item);
    const visible = detailed.slice(0, 20);
    const suffix = detailed.length > visible.length ? `、等${detailed.length - visible.length}项` : '';
    const words = visible.map(item => item.snippet && item.snippet !== item.word ? `${item.word}（命中片段：${item.snippet}）` : item.word);
    return `${source}命中屏蔽词：${words.join('、')}${suffix}`;
}

/**
 * 监视器
 */
class Monitor extends Searcher {
    /**
     * @constructor
     * @param {[string, number | string]} lottery_param
     */
    constructor(lottery_param, taskContext = {}) {
        super();
        this.lottery_param = lottery_param;
        this.taskContext = taskContext;
        this.tagid = taskContext.tagid || config.partition_id; /* tagid初始化 */
        this.attentionList = taskContext.attentionList instanceof Set
            ? taskContext.attentionList
            : new Set();
        this.LotteryInfoMap = new Map([
            ['UIDs', this.getLotteryInfoByUID.bind(this)],
            ['TAGs', this.getLotteryInfoByTag.bind(this)],
            ['Articles', this.getLotteryInfoByArticle.bind(this)],
            ['ArticleUIDs', this.getLotteryInfoByArticleUID.bind(this)],
            ['APIs', this.getLotteryInfoByAPI.bind(this)],
            ['TxT', this.getLotteryInfoByTxT.bind(this)],
            ['FollowFeed', this.getLotteryInfoByFollowFeed.bind(this)]
        ]);
    }
    /**
     * 初始化
     */
    async init() {
        const isDiscovery = hasEnv('NOT_GO_LOTTERY');
        if (config.model === '00') {
            event_bus.emit('Turn_off_the_Monitor', '已关闭所有转发行为');
            return;
        }
        if (!isDiscovery
            && !this.tagid
            && config.is_not_create_partition !== true) {
            this.tagid = await bili.checkMyPartition(); /* 检查关注分区 */
            if (!this.tagid) {
                event_bus.emit('Turn_off_the_Monitor', new Error('分区获取失败'));
                return;
            }
            this.taskContext.tagid = this.tagid;
        }
        /** 关注列表初始化 */
        if (!(this.taskContext.attentionList instanceof Set)) {
            if (!isDiscovery || config.only_followed) {
                this.attentionList = await bili.getAttentionList(global_var.get('myUID'));
                if (!(this.attentionList instanceof Set)) {
                    event_bus.emit('Turn_off_the_Monitor', new Error('关注列表在线获取失败且无24小时内有效缓存'));
                    return;
                }
                this.taskContext.attentionList = this.attentionList;
            } else {
                this.taskContext.attentionList = this.attentionList;
            }
        } else {
            this.attentionList = this.taskContext.attentionList;
        }
        const status = await this.startLottery();
        switch (status) {
            case 0:
                event_bus.emit('Turn_on_the_Monitor');
                break;
            case 1001:
                event_bus.emit('Turn_off_the_Monitor', '评论失败');
                break;
            case 1010:
                event_bus.emit('Turn_off_the_Monitor', '已掉号');
                break;
            case 1004:
                event_bus.emit('Turn_off_the_Monitor', '需要输入验证码');
                break;
            case 2001:
                event_bus.emit('Turn_off_the_Monitor', '关注出错');
                break;
            case 2004:
            case 4005:
                log.warn(`账号异常${status}`, `UID(${global_var.get('myUID')})异常号只会对部分UP出现异常`);
                if (!config.is_exception) {
                    await sendNotify(
                        `[动态抽奖]账号异常${status}通知`,
                        `UID: ${global_var.get('myUID')}\n异常号只会对部分UP出现异常\n可在设置中令is_exception为true关闭此推送\n${log._cache.filter(it => /Error|\s抽奖信息\]/.test(it)).join('\n')}`
                    );
                }
                config.is_exception = true;
                event_bus.emit('Turn_on_the_Monitor');
                break;
            case 2005:
                log.warn('关注已达上限', `UID(${global_var.get('myUID')})关注已达上限,已临时进入只转已关注模式`);
                if (!config.is_outof_maxfollow) {
                    await sendNotify(
                        '[动态抽奖]关注已达上限',
                        `UID: ${global_var.get('myUID')}\n关注已达上限,已临时进入只转已关注模式\n可在设置中令is_outof_maxfollow为true关闭此推送\n${log._cache.filter(it => /Error|\s抽奖信息\]/.test(it)).join('\n')}`
                    );
                }
                config.is_outof_maxfollow = true;
                config.only_followed = true;
                event_bus.emit('Turn_on_the_Monitor');
                break;
            case 5001:
                event_bus.emit('Turn_off_the_Monitor', '转发失败');
                break;
            default:
                event_bus.emit('Turn_off_the_Monitor', `??? 未知错误: ${status}`);
                break;
        }
    }
    /**
     * 启动
     * @returns {Promise<number>}
     */
    async startLottery() {
        const allLottery = await this.filterLotteryInfo()
            , len = allLottery.length
            , { create_dy, create_dy_mode, wait, filter_wait } = config
            , isDiscovery = hasEnv('NOT_GO_LOTTERY');

        if (!isDiscovery && !this.taskContext.videoShareController) {
            this.taskContext.videoShareController = new VideoShareController();
        }

        log.info('筛选动态', `筛选完毕(${len})`);

        if (len) {
            let
                status = 0,
                is_exception = 0,
                is_outof_maxfollow = 0,
                relayed_nums = 0,
                total_nums = 0;
            for (const [index, lottery] of shuffle(allLottery).entries()) {
                total_nums += 1;
                let is_shutdown = false;
                if (
                    is_outof_maxfollow
                    && lottery.uid.length
                    && lottery.uid.some(uid => !hasFollowing(this.attentionList, uid))
                ) {
                    log.info('过滤', `已关注(${lottery.uid.join(',')})`);
                    continue;
                }

                if (lottery.isOfficialLottery) {
                    let { ts } = await bili.getLotteryNotice(lottery.dyid);
                    const ts_10 = Date.now() / 1000;
                    if (ts === -1) {
                        log.warn('过滤', '无法判断开奖时间');
                        emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'filtered', resultReason: '无法获取官方开奖时间' } });
                        await delay(filter_wait);
                        continue;
                    }
                    if (ts === -9999) {
                        log.info('过滤', '已撤销抽奖');
                        emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'filtered', resultReason: '官方抽奖已撤销' } });
                        await this.markProcessed(lottery.dyid);
                        await delay(filter_wait);
                        continue;
                    }
                    if (ts < ts_10) {
                        log.info('过滤', '已过开奖时间');
                        emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'filtered', resultReason: '已过开奖时间（官方接口）', drawTime: ts, drawTimeSource: 'official_api' } });
                        await this.markProcessed(lottery.dyid);
                        await delay(filter_wait);
                        continue;
                    }
                    if (ts > ts_10 + config.maxday * 86400) {
                        log.info('过滤', '超过指定开奖时间');
                        emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'filtered', resultReason: '开奖时间超过配置范围（官方接口）', drawTime: ts, drawTimeSource: 'official_api' } });
                        await this.markProcessed(lottery.dyid);
                        await delay(filter_wait);
                        continue;
                    }
                    lottery.drawtime = ts;
                    lottery.drawTimeSource = 'official_api';
                } else if (lottery.uid[0]) {
                    const { minfollower } = config;
                    if (minfollower > 0) {
                        const followerNum = await bili.getUserInfo(lottery.uid[0]);
                        if (followerNum === -1) {
                            log.warn('过滤', `粉丝数(${followerNum})获取失败`);
                            emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'filtered', resultReason: '获取发起人粉丝数失败' } });
                            await delay(filter_wait);
                            continue;
                        }
                        if (followerNum < minfollower) {
                            log.info('过滤', `粉丝数(${followerNum})小于指定数量`);
                            emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'filtered', resultReason: `粉丝数 ${followerNum} 小于配置要求` } });
                            await this.markProcessed(lottery.dyid);
                            await delay(filter_wait);
                            continue;
                        }
                    } else {
                        log.info('过滤', '不过滤粉丝数');
                    }
                }

                if (!lottery.isOfficialLottery && lottery.drawtime > 0) {
                    const source = lottery.drawTimeSource === 'reserve_text' ? '预约文本' : '正文';
                    if (lottery.drawtime < Date.now() / 1000) {
                        log.info('过滤', `已过开奖时间（${source}解析）`);
                        emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'filtered', resultReason: `已过开奖时间（${source}解析）`, drawTime: lottery.drawtime, drawTimeSource: 'text' } });
                        await this.markProcessed(lottery.dyid);
                        await delay(filter_wait);
                        continue;
                    }
                    if (Number.isFinite(config.maxday) && lottery.drawtime > Date.now() / 1000 + config.maxday * 86400) {
                        log.info('过滤', `开奖时间超过配置范围（${source}解析）`);
                        emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'filtered', resultReason: `开奖时间超过配置范围（${source}解析）`, drawTime: lottery.drawtime, drawTimeSource: 'text' } });
                        await this.markProcessed(lottery.dyid);
                        await delay(filter_wait);
                        continue;
                    }
                }

                if (!isDiscovery && create_dy
                    && create_dy_mode instanceof Array
                    && index > 0
                    && index % getRandomOne(create_dy_mode[0]) === 0
                ) {
                    const number = getRandomOne(create_dy_mode[1]) || 0;
                    await randomDynamic(number);
                }

                const participation = await this.go(lottery);
                status = participation.code;
                if (isDiscovery) {
                    emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: 'candidate', resultReason: '演练发现，未执行写操作', drawTime: lottery.drawtime, drawTimeSource: lottery.drawTimeSource || 'unknown' } });
                } else {
                    const lotteryStatus = participation.overallStatus === 'success' ? 'participated' : participation.overallStatus;
                    emitRuntimeEvent('lottery', { lottery: { dyid: lottery.dyid, status: lotteryStatus, resultReason: participation.reason, drawTime: lottery.drawtime, drawTimeSource: lottery.drawTimeSource || 'unknown' } });
                    emitRuntimeEvent('lottery_participation', { participation: { dyid: String(lottery.dyid), ...participation } });
                    if (participation.relay?.status === 'success' && this.taskContext.videoShareController) {
                        try {
                            await this.taskContext.videoShareController.recordSuccessfulForward();
                        } catch (error) {
                            log.warn('视频分享', `触发视频分享失败：${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                }
                switch (status) {
                    case 0:
                        if (!isDiscovery) relayed_nums += 1;
                        break;
                    case 1002:
                    case 1003:
                    case 1005:
                    case 1006:
                    case 1007:
                    case 1008:
                    case 1009:
                    case 1011:
                    case 2002:
                    case 2003:
                    case 3001:
                    case 4001:
                    case 4002:
                    case 4003:
                    case 4004:
                    case 5002:
                    case 5003:
                    case 5004:
                    case 5005:
                        status = 0;
                        break;
                    case 2004:
                        is_exception = 2004;
                        break;
                    case 4005:
                        is_exception = 4005;
                        break;
                    case 2005:
                        is_outof_maxfollow = 2005;
                        break;
                    case 1001:
                    case 1010:
                    case 1004:
                    case 2001:
                    case 5001:
                        is_shutdown = true;
                        break;
                    default:
                        break;
                }

                if (is_shutdown) break;

                await this.markProcessed(lottery.dyid);

                if (!isDiscovery) await delay(wait * (Math.random() + 0.5));
            }
            if (isDiscovery) {
                log.info('仅发现抽奖', `本轮筛选完成，共发现${total_nums}条候选，未执行任何B站写操作`);
            } else {
                log.info('抽奖', `本轮共处理${total_nums}条,成功参与${relayed_nums}条`);
            }
            return is_exception
                || is_outof_maxfollow
                || status;
        } else {
            log.info(isDiscovery ? '仅发现抽奖' : '抽奖', isDiscovery
                ? '本轮扫描成功，未发现符合条件的抽奖'
                : '无未转发抽奖');
            return 0;
        }
    }

    markProcessed(dyid) {
        if (hasEnv('NOT_GO_LOTTERY')) return Promise.resolve();
        return d_storage.updateDyid(dyid);
    }

    /**
     * 抽奖配置
     * @typedef {object} LotteryOptions
     * @property {number[]} uid 用户标识
     * @property {string} dyid 动态标识
     * @property {boolean} isOfficialLottery 是否官方抽奖
     * @property {number} drawtime 开奖时间t10
     * @property {string} relay_chat 转发词
     * @property {string} ctrl 定位@
     * @property {string} [rid] 评论标识
     * @property {number} chat_type 评论类型
     * @property {string} [chat] 评论词
     * @property {boolean} [isAiChat] 是否为AI生成的评论
     * @property {string} [comment_source] 评论文案来源
     * @property {string} relay_source 转发文案来源
     * @property {string} author 动态作者
     * @property {string} description 动态正文
     * @property {string} url 动态链接
     */
    /**
     * @returns {Promise<LotteryOptions[]>}
     */
    async filterLotteryInfo() {
        const { lottery_param, LotteryInfoMap, attentionList } = this;
        /**
         * @type {import("./searcher").LotteryInfo[]}
         */
        let protoLotteryInfo = await LotteryInfoMap.get(lottery_param[0])(lottery_param[1]);

        if (protoLotteryInfo === null)
            return [];

        log.info('筛选动态', `开始筛选(${protoLotteryInfo.length})`);

        /** 所有抽奖信息 */
        let alllotteryinfo = [];
        const
            {
                check_if_duplicated, save_lottery_info_to_file,
                set_lottery_info_url, disable_reserve_lottery,
                is_not_relay_reserve_lottery,
                reserve_lottery_wait, sneaktower, key_words,
                model, chatmodel, relay: relays,
                block_dynamic_type, max_create_time, is_imitator,
                only_followed, at_users, blockword, blockword_match_mode = 'literal', blacklist, blocked_lottery_uids,
                copy_chat_on_ai_failure,
                ai_judge_parm, ai_relay_parm,
            } = config,
            now_ts = Date.now() / 1000;
        let aiRequestCount = 0;
        const aiRequestLimit = Number(process.env.AI_MAX_REQUESTS_PER_RUN || 30);
        const sourceByConfig = { UIDs: 'uid', TAGs: 'tag', Articles: 'article', ArticleUIDs: 'article_uid', APIs: 'api', TxT: 'txt', FollowFeed: 'follow_feed' };
        const emitLottery = (lottery, status, resultReason = '', extra = {}) => emitRuntimeEvent('lottery', { lottery: {
            dyid: String(lottery.dyid || ''), source: lottery.lottery_info_type || sourceByConfig[lottery_param[0]] || 'runtime', author: String(lottery.uname || ''),
            authorUid: lottery.author_uid ? String(lottery.author_uid) : undefined,
            description: String(lottery.des || ''), official: Boolean(lottery.hasOfficialLottery), sourceCreatedAt: Number(lottery.create_time || 0) || null,
            url: `https://t.bilibili.com/${lottery.dyid}`, status, resultReason, ...extra
        } });

        /**
         * @type {Map<String, Boolean>}
         */
        let dyids_map = new Map();

        /**去重 */
        protoLotteryInfo = protoLotteryInfo.filter(({ dyid }) => {
            if (dyids_map.has(dyid)) {
                return false;
            }
            dyids_map.set(dyid, false);
            return true;
        });

        log.info('筛选动态', `去重后(${protoLotteryInfo.length})`);

        /**并发查询dyid */
        if (check_if_duplicated >= 1) {
            await Promise.all(
                [...dyids_map.keys()]
                    .map(it => d_storage
                        .searchDyid(it)
                        .then(hasIt => dyids_map.set(it, hasIt))
                    )
            );
            log.info('筛选动态', '并发查询本地dyid完毕');
        }

        if (lottery_param[0] !== 'APIs' && save_lottery_info_to_file && protoLotteryInfo.length) {
            log.info('保存抽奖信息', '保存开始');
            await appendLotteryInfoFile(lottery_param[1].toString(), protoLotteryInfo);
        }

        if (lottery_param[0] !== 'APIs' && set_lottery_info_url && protoLotteryInfo.length) {
            log.info('上传抽奖信息', '上传开始');
            await new Promise((resolve) => {
                send({
                    url: set_lottery_info_url,
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json'
                    },
                    contents: protoLotteryInfo,
                    success: ({ body }) => {
                        log.info('发送获取到的动态数据', body);
                        resolve();
                    },
                    failure: err => {
                        log.error('发送获取到的动态数据', err);
                        resolve();
                    }
                });
            });
        }

        /* 检查动态是否满足要求 */
        await try_for_each(protoLotteryInfo, async function (lottery_info) {
            const {
                lottery_info_type, is_liked,
                uids, uname, dyid, reserve_id,
                reserve_lottery_text,
                is_charge_lottery,
                create_time, chat_type,
                ctrl, rid, des, type,
                hasOfficialLottery
            } = lottery_info;

            log.debug('正在筛选的动态信息', lottery_info);
            emitLottery(lottery_info, 'discovered');

            if (des === '') {
                log.info('筛选动态', `获取动态内容为空(https://t.bilibili.com/${dyid})风控`);
                emitLottery(lottery_info, 'filtered', '动态正文为空或受到风控');
                return false;
            }

            if (lottery_info_type.startsWith('sneak') && sneaktower) {
                log.info('筛选动态', `偷塔模式不检查是否已转发(https://t.bilibili.com/${dyid})`);
            } else {
                /* 遇到转发过就退出 */
                if (
                    ((!check_if_duplicated || check_if_duplicated >= 2) && is_liked)
                    || ((check_if_duplicated >= 1) && dyids_map.get(dyid))
                ) {
                    log.info('筛选动态', `当前账号已参与或已转发(https://t.bilibili.com/${dyid})`);
                    emitLottery(lottery_info, 'filtered', '当前账号已参与或已转发');
                    return false;
                }
            }

            /* 超过指定时间退出 */
            if (create_time && now_ts - create_time > max_create_time * 86400) {
                log.info('筛选动态', `过时动态(https://t.bilibili.com/${dyid})`);
                emitLottery(lottery_info, 'filtered', '动态发布时间超过配置范围');
                return false;
            }

            if (is_charge_lottery) {
                log.info('筛选动态', `充电抽奖(https://t.bilibili.com/${dyid})`);
                emitLottery(lottery_info, 'filtered', '充电抽奖不参与');
                return false;
            }

            let
                [m_uid, ori_uid] = uids,
                mIsFollowed = hasFollowing(attentionList, m_uid),
                oriIsFollowed = hasFollowing(attentionList, ori_uid),
                /**判断是转发源动态还是现动态 实际发奖人*/
                [real_uid, realIsFollowed] = (type === 1 && ori_uid)
                    ? [ori_uid, oriIsFollowed]
                    : lottery_info_type === 'uid'
                        ? [ori_uid, oriIsFollowed]
                        : [m_uid, mIsFollowed],
                description = des.split(/\/\/@.*?:/)[0],
                needAt = /(?:@|艾特)[^@|(艾特)]*?好友/.test(description),
                needTopic = [...new Set(description.match(/(?<=[带加]上?(?:话题|tag).*)#.+?#|(?<=[带加])上?#.+?#(?=话题|tag)/ig) || [])].join(' '),
                isRelayDynamic = type === 1,
                has_key_words = key_words.every(it => new RegExp(it).test(description)),
                bodyBlockwords = getBlockwordMatches(blockword, description, blockword_match_mode),
                reserveBlockwords = getBlockwordMatches(blockword, reserve_lottery_text, blockword_match_mode),
                isBlock = bodyBlockwords.length > 0 || reserveBlockwords.length > 0,
                isLottery =
                    (is_imitator && lottery_info_type === 'uid' && model !== '00')
                    || (hasOfficialLottery && model[0] === '1')
                    || (!hasOfficialLottery && model[1] === '1' && has_key_words),
                isSendChat =
                    (hasOfficialLottery && chatmodel[0] === '1')
                    || (!hasOfficialLottery && chatmodel[1] === '1'),
                drawtime = parseDrawTime(description, create_time) || parseDrawTime(reserve_lottery_text, create_time) || -1,
                drawTimeSource = drawtime > 0 ? (parseDrawTime(description, create_time) ? 'text' : 'reserve_text') : 'unknown',
                aiDrawtime = null,
                keys = [dyid, m_uid, ori_uid];

            lottery_info.author_uid = real_uid;

            log.debug('筛选动态', { real_uid, mIsFollowed, oriIsFollowed, realIsFollowed, needAt, needTopic, type, isRelayDynamic, key_words, has_key_words, blockword, blockwordMatchMode: blockword_match_mode, bodyBlockwords, reserveBlockwords, isBlock, isLottery, isSendChat, drawtime, drawTimeSource });

            if (
                blacklist.split(',').some(id => keys.some(key => {
                    if (key + '' === id) {
                        log.info('筛选动态', `黑名单匹配(${id})(https://t.bilibili.com/${dyid})`);
                        emitLottery(lottery_info, 'filtered', `命中黑名单 ${id}`);
                        return true;
                    } else {
                        return false;
                    }
                }))
            ) {
                return false;
            }

            const blockedLotteryUid = () => findBlockedLotteryUid(real_uid, blocked_lottery_uids);
            // 预约入口会在 AI 判断前写入。只要当前动态可能参与或存在预约入口，
            // 就先按实际发起人检查 UID，避免命中屏蔽用户后才产生写操作。
            if (isLottery || reserve_id) {
                const blockedUid = blockedLotteryUid();
                if (blockedUid) {
                    const reason = `命中屏蔽用户 UID：${blockedUid}`;
                    log.info('筛选动态', `${reason}(https://t.bilibili.com/${dyid})`);
                    emitLottery(lottery_info, 'filtered', reason);
                    return false;
                }
            }

            if (block_dynamic_type.includes(type)) {
                log.warn('筛选动态', `屏蔽动态类型 ${type}`);
                emitLottery(lottery_info, 'filtered', `动态类型 ${type} 已屏蔽`);
                return false;
            }

            /**屏蔽词 */
            if (isBlock) {
                const reasons = [];
                if (bodyBlockwords.length) reasons.push(blockwordReason(bodyBlockwords, '正文'));
                if (reserveBlockwords.length) reasons.push(blockwordReason(reserveBlockwords, '预约文本'));
                const reason = reasons.join('；') || '正文命中屏蔽词';
                log.info('筛选动态', `${reason}(https://t.bilibili.com/${dyid})`);
                emitLottery(lottery_info, 'filtered', reason);
                return false;
            }

            if (reserve_id) {
                if (disable_reserve_lottery) {
                    log.info('预约抽奖', '已关闭预约抽奖功能');
                } else {
                    log.info('预约抽奖', '开始');
                    log.info('预约抽奖', `奖品: ${reserve_lottery_text}`);
                    if (hasEnv('NOT_GO_LOTTERY')) {
                        log.info('NOT_GO_LOTTERY', 'ON');
                    } else {
                        await delay(reserve_lottery_wait);
                        await bili.reserve_lottery(reserve_id);
                    }
                }
                if (is_not_relay_reserve_lottery === true) {
                    log.info('预约抽奖', '已关闭预约抽奖转关功能');
                    return false;
                }
            }

            if (!hasOfficialLottery && model[1] === '1') {
                if (hasEnv('ENABLE_AI_JUDGE') && aiRequestCount < aiRequestLimit) {
                    aiRequestCount += 1;
                    let msg = await getAiContent(
                        ai_judge_parm.url,
                        ai_judge_parm.body,
                        renderAiPrompt(ai_judge_parm.prompt, { dynamic_text: lottery_info.des, author: uname, lottery_conditions: description, draw_time: String(drawtime), account_name: process.env.NOTE || '' }),
                        lottery_info.des
                    );
                    const msg_json = extractJsonObject(msg);
                    if (!msg_json) {
                        log.warn('ai判断抽奖', 'AI 返回内容无法解析为 JSON，保留关键词和正文规则继续判断');
                    } else {
                        if (typeof msg_json.has_key_words == 'boolean') {
                            has_key_words = msg_json.has_key_words;
                            isLottery = has_key_words;
                        } else {
                            log.warn('ai判断抽奖', 'no has_key_words');
                        }
                        if (typeof msg_json.needAt == 'boolean') {
                            needAt = msg_json.needAt;
                        } else {
                            log.warn('ai判断抽奖', 'no needAt');
                        }
                        if (typeof msg_json.needTopic == 'string') {
                            needTopic = msg_json.needTopic;
                        } else {
                            log.warn('ai判断抽奖', 'no needTopic');
                        }
                        const advisoryDrawtime = normalizeAiDrawTime(msg_json.drawtime);
                        if (advisoryDrawtime) {
                            aiDrawtime = advisoryDrawtime;
                            log.info('ai判断抽奖', `AI 开奖时间仅作参考：${advisoryDrawtime}`);
                        } else {
                            log.info('ai判断抽奖', '未采用 AI 开奖时间，等待正文或官方接口时间');
                        }
                        log.info('ai判断抽奖', msg_json.more);
                    }
                } else if (hasEnv('ENABLE_AI_JUDGE')) {
                    log.warn('ai判断抽奖', '已达到本次任务 AI 请求上限');
                }
                if (!has_key_words && description) {
                    log.warn('筛选动态', `无关键词动态的描述: ${description}\n\n考虑是否修改设置key_words或ai提示词`);
                }
            }

            /**若勾选只转已关注 */
            if (only_followed && !realIsFollowed) {
                log.info('筛选动态', `只转已关注(https://t.bilibili.com/${dyid})`);
                emitLottery(lottery_info, 'filtered', '发起人不满足仅参与已关注账号的配置');
                return false;
            }

            if (isLottery) {
                const blockedUid = blockedLotteryUid();
                if (blockedUid) {
                    const reason = `命中屏蔽用户 UID：${blockedUid}`;
                    log.info('筛选动态', `${reason}(https://t.bilibili.com/${dyid})`);
                    emitLottery(lottery_info, 'filtered', reason);
                    return false;
                }
                if (!real_uid || String(real_uid) === '0') {
                    const reason = '无法识别发起人，未参与';
                    log.warn('筛选动态', `${reason}(https://t.bilibili.com/${dyid})`);
                    emitLottery(lottery_info, 'filtered', reason, { drawTime: drawtime > 0 ? drawtime : null, drawTimeSource, aiDrawTime: aiDrawtime });
                    return false;
                }
                let onelotteryinfo = {};

                onelotteryinfo.isOfficialLottery = hasOfficialLottery;
                onelotteryinfo.is_liked = Boolean(is_liked);

                onelotteryinfo.drawtime = drawtime;
                onelotteryinfo.drawTimeSource = drawTimeSource;

                /**初始化待关注列表 */
                onelotteryinfo.uid = [real_uid].filter(uid => uid && String(uid) !== '0');

                onelotteryinfo.dyid = dyid;
                onelotteryinfo.author = uname;
                onelotteryinfo.description = des;
                onelotteryinfo.url = `https://t.bilibili.com/${dyid}`;

                let
                    /**转发评语 */
                    RandomStr = (getRandomOne(relays) || '!!!')
                        .replace(/\$\{uname\}/g, uname),
                    relayTextSource = 'configured',
                    /**控制字段 */
                    new_ctrl = [];

                if (!hasEnv('NOT_GO_LOTTERY') && hasEnv('ENABLE_AI_RELAY') && ai_relay_parm && aiRequestCount < aiRequestLimit) {
                    aiRequestCount += 1;
                    try {
                        log.info('开始获取Ai转发附言', `(https://t.bilibili.com/${dyid})`);
                        const generatedRelay = await getAiContent(
                            ai_relay_parm.url,
                            ai_relay_parm.body,
                            renderAiPrompt(ai_relay_parm.prompt, { dynamic_text: des, author: uname, lottery_conditions: description, draw_time: String(drawtime), account_name: process.env.NOTE || '' }),
                            des
                        );
                        const aiRelay = safeAiText(generatedRelay, '');
                        if (aiRelay) {
                            RandomStr = aiRelay;
                            relayTextSource = 'ai';
                            log.info('获取到Ai转发附言', RandomStr);
                        } else {
                            const fallbackRelay = safeAiText(process.env.AI_FALLBACK_RELAY, '');
                            if (process.env.AI_ALLOW_EMPTY_RELAY) {
                                RandomStr = '';
                                relayTextSource = 'empty';
                            } else if (fallbackRelay) {
                                RandomStr = fallbackRelay;
                                relayTextSource = 'fallback';
                            } else {
                                RandomStr = safeAiText(RandomStr, '');
                                relayTextSource = RandomStr ? 'configured' : 'empty';
                            }
                            log.warn('获取AI转发附言失败', RandomStr ? '未返回有效内容，使用备用文案' : '未返回有效内容，使用空附言');
                        }
                    } catch (e) {
                        log.error('获取AI转发附言失败，使用备用文案', String(e));
                        const fallbackRelay = safeAiText(process.env.AI_FALLBACK_RELAY, '');
                        if (process.env.AI_ALLOW_EMPTY_RELAY) {
                            RandomStr = '';
                            relayTextSource = 'empty';
                        } else if (fallbackRelay) {
                            RandomStr = fallbackRelay;
                            relayTextSource = 'fallback';
                        } else {
                            RandomStr = safeAiText(RandomStr, '');
                            relayTextSource = RandomStr ? 'configured' : 'empty';
                        }
                    }
                }

                /* 是否需要带话题 */
                if (needTopic) {
                    RandomStr += needTopic;
                }

                /* 是否需要@ */
                if (needAt) {
                    at_users.forEach(it => {
                        new_ctrl.push({
                            data: String(it[1]),
                            location: RandomStr.length,
                            length: it[0].length + 1,
                            type: 1
                        });
                        RandomStr += '@' + it[0];
                    });
                }

                /* 是否是转发的动态 */
                if (isRelayDynamic) {
                    /* 转发内容长度+'//'+'@'+用户名+':'+源内容 */
                    const addlength = RandomStr.length + 2 + uname.length + 1 + 1;
                    onelotteryinfo.relay_chat = RandomStr + `//@${uname}:` + des;
                    new_ctrl.push({
                        data: String(real_uid),
                        location: RandomStr.length + 2,
                        length: uname.length + 1,
                        type: 1
                    });
                    ctrl.map(item => {
                        item.location += addlength;
                        return item;
                    }).forEach(it => new_ctrl.push(it));
                } else {
                    onelotteryinfo.relay_chat = RandomStr;
                }
                onelotteryinfo.relay_source = relayTextSource;

                onelotteryinfo.ctrl = JSON.stringify(new_ctrl);

                /* 根据动态的类型决定评论的类型 */
                onelotteryinfo.chat_type = chat_type;

                /* 是否评论 */
                if (isSendChat) {
                    onelotteryinfo.rid = rid;
                    if (!hasEnv('NOT_GO_LOTTERY')) {
                        const comment = await buildComment({
                            rid,
                            rid_str: rid,
                            chat_type,
                            description: lottery_info.des,
                            uname,
                            lottery_conditions: description,
                            draw_time: drawtime
                        }, {
                            config: { ...config, copy_chat_on_ai_failure },
                            canUseAi: () => {
                                if (aiRequestCount >= aiRequestLimit) {
                                    log.warn('获取AI评论失败', '已达到本次任务 AI 请求上限');
                                    return false;
                                }
                                aiRequestCount += 1;
                                log.info('开始获取Ai评论', `(https://t.bilibili.com/${dyid})`);
                                return true;
                            }
                        });
                        onelotteryinfo.chat = comment.text || '!!!';
                        onelotteryinfo.comment_source = comment.source;
                        onelotteryinfo.isAiChat = comment.source === 'ai';
                        if (comment.source === 'ai') log.info('获取到Ai评论内容', onelotteryinfo.chat);
                        else if (comment.source === 'copied') log.info('获取到复制评论', onelotteryinfo.chat);
                    } else {
                        onelotteryinfo.chat = configuredComment({ uname }, config) || '!!!';
                        onelotteryinfo.comment_source = 'configured';
                    }
                }

                alllotteryinfo.push(onelotteryinfo);
                emitLottery(lottery_info, 'candidate', '符合抽奖筛选条件', { drawTime: drawtime > 0 ? drawtime : null, drawTimeSource, aiDrawTime: aiDrawtime });
            } else {
                log.info('筛选动态', `非抽奖动态(https://t.bilibili.com/${dyid})`);
                emitLottery(lottery_info, 'filtered', '未满足抽奖关键词或判断条件');
            }
        });

        return alllotteryinfo;
    }
    /**
     * 关注转发评论
     * @param {LotteryOptions} option
     * @returns {Promise<object>}
     * - 成功 0
     * - 评论 未知错误 1001
     * - 评论 原动态已删除 1002
     * - 评论 评论区已关闭 1003
     * - 评论 需要输入验证码 1004
     * - 评论 已被对方拉入黑名单 1005
     * - 评论 黑名单用户无法互动 1006
     * - 评论 UP主已关闭评论区 1007
     * - 评论 内容包含敏感信息 1008
     * - 评论 重复评论 1009
     * - 评论 帐号未登录 1010
     * - 评论 关注UP主7天以上的人可发评论 1011
     * - 评论 账号未转正 1013
     * - 关注 未知错误 2001
     * - 关注 您已被对方拉入黑名单 2002
     * - 关注 黑名单用户无法关注 2003
     * - 关注 账号异常 2004
     * - 关注 关注已达上限 2005
     * - 分区 移动失败 3001
     * - 点赞 未知错误 4001
     * - 点赞 点赞异常 4002
     * - 点赞 点赞频繁 4003
     * - 点赞 已赞过 4004
     * - 点赞 账号异常，点赞失败 4005
     * - 转发 未知错误 5001
     * - 转发 该动态不能转发分享 5002
     * - 转发 请求数据发生错误，请刷新或稍后重试 5003
     * - 转发 操作太频繁了，请稍后重试 5004
     * - 转发 源动态禁止转发 5005
     */
    async go(option) {
        log.debug('正在转发的动态信息', option);
        const startedAt = new Date().toISOString();
        const permanentActionErrors = this.taskContext.permanentActionErrors
            && typeof this.taskContext.permanentActionErrors === 'object'
            ? this.taskContext.permanentActionErrors
            : (this.taskContext.permanentActionErrors = {});
        const permanentErrorCodes = {
            comment: -107,
            relay: 4126021
        };
        const action = (required, plannedText = null, source = 'none') => ({
            plannedText,
            actualText: null,
            source,
            status: required ? 'not_attempted' : 'not_required',
            code: 0,
            reason: required ? '等待执行' : '当前配置未要求此操作',
            attempts: []
        });
        let status = 0;
        let successCount = 0;
        let firstFailureCode = 0;
        let { uid = [], dyid, chat_type, rid, relay_chat, ctrl, chat, isAiChat, comment_source, relay_source, is_liked, commentOnly = false, author } = option;
        const { is_copy_chat, copy_blockword, is_repost_then_chat, is_not_create_partition } = config;
        uid = Array.isArray(uid) ? uid.filter(value => value && String(value) !== '0').map(String) : [];
        const actions = {
            comment: action(Boolean(rid && chat_type), chat ?? null, comment_source || 'none'),
            follow: action(!commentOnly && Boolean(uid.length)),
            like: action(!commentOnly && Boolean(dyid)),
            relay: action(!commentOnly && Boolean(dyid), relay_chat ?? '', relay_source || (relay_chat ? 'configured' : 'empty'))
        };
        const finish = (code = 0) => {
            const failures = Object.values(actions).filter(item => item.status === 'failed').map(item => item.reason).filter(Boolean);
            return {
                code: firstFailureCode || code,
                overallStatus: failures.length ? successCount > 0 ? 'partial' : 'failed' : 'success',
                reason: failures.length ? [...new Set(failures)].join('；') : participationReason(firstFailureCode || code),
                ...actions,
                startedAt,
                finishedAt: new Date().toISOString()
            };
        };
        const appendAttempts = (currentAction, result) => {
            currentAction.attempts.push(...(result.attempts || []).map(item => ({ ...item })));
        };
        const rememberPermanentError = (actionName, result) => {
            const expectedCode = permanentErrorCodes[actionName];
            if (expectedCode === undefined || Number(result.providerCode) !== expectedCode) return;
            permanentActionErrors[actionName] = {
                code: result.internalCode,
                providerCode: Number(result.providerCode),
                reason: result.reason || participationReason((actionName === 'comment' ? 1000 : 5000) + result.internalCode)
            };
        };
        const failFromPermanentError = (actionName, currentAction, label) => {
            const previous = permanentActionErrors[actionName];
            if (!previous) return false;
            currentAction.status = 'failed';
            currentAction.code = previous.code;
            currentAction.reason = `${label}失败：${previous.reason}；本轮后续${label}请求已停止`;
            if (!firstFailureCode) firstFailureCode = (actionName === 'comment' ? 1000 : 5000) + previous.code;
            return true;
        };
        const fail = (fullCode, currentAction, result, label) => {
            currentAction.status = 'failed';
            currentAction.code = result.internalCode;
            currentAction.reason = `${label}失败：${result.reason || participationReason(fullCode).replace(/^.*?失败：/, '')}`;
            if (!firstFailureCode) firstFailureCode = fullCode;
            rememberPermanentError(currentAction === actions.comment ? 'comment' : currentAction === actions.relay ? 'relay' : '', result);
        };
        if (hasEnv('NOT_GO_LOTTERY')) {
            log.info('NOT_GO_LOTTERY', 'ON');
            return finish(0);
        }

        /* 评论 */
        if (rid && chat_type && failFromPermanentError('comment', actions.comment, '评论')) {
            log.warn('抽奖信息', `dyid: ${dyid}, 评论接口本轮已停止：B站返回 ${permanentActionErrors.comment.providerCode}`);
        } else if (rid && chat_type) {
            if (is_copy_chat && !comment_source) {
                const copied = await fetchCopiedComment(rid, chat_type, {
                    config: { ...config, copy_blockword },
                    myUname: global_var.get('myUNAME') || '',
                    upUname: author || ''
                });
                if (copied?.text) {
                    chat = copied.text;
                    actions.comment.source = 'copied';
                } else {
                    chat = chat || '!!!';
                }
            } else if (is_repost_then_chat) {
                if (isAiChat) {
                    relay_chat = chat;
                    actions.relay.source = 'ai';
                } else {
                    chat = chat + relay_chat;
                }
            }
            actions.comment.actualText = String(chat || '');
            let commentResult = await retryDetailed(6, [4], () => bili.sendChatWithOcrDetailed(rid, chat, chat_type));
            appendAttempts(actions.comment, commentResult);
            status = commentResult.internalCode;
            if (status === 9 && commentOnly) {
                const lastAttempt = actions.comment.attempts[actions.comment.attempts.length - 1];
                if (lastAttempt) lastAttempt.status = 'already_done';
                actions.comment.status = 'success';
                actions.comment.reason = '检测到重复评论，视为已完成';
                actions.comment.source = actions.comment.source || 'configured';
                successCount += 1;
                status = 0;
            } else if (status === 8 || status === 9) {
                actions.comment.actualText = '[doge][doge][doge][doge][doge]';
                actions.comment.source = 'safety_fallback';
                commentResult = await bili.sendChatWithOcrDetailed(rid, actions.comment.actualText, chat_type);
                for (const attempt of commentResult.attempts || []) attempt.attemptNo = actions.comment.attempts.length + (attempt.attemptNo || 1);
                appendAttempts(actions.comment, commentResult);
                status = commentResult.internalCode;
            }
            if (status) {
                log.warn('抽奖信息', `dyid: ${dyid}, rid: ${rid}, chat_type: ${chat_type}`);
                fail(1000 + status, actions.comment, commentResult, '评论');
            } else if (actions.comment.status !== 'success') {
                actions.comment.status = 'success';
                actions.comment.reason = '评论成功';
                successCount += 1;
            }
        }

        /* 关注：已关注视为成功，单个目标失败不阻断后续动作。 */
        if (!commentOnly && uid.length) {
            let followFailed = false;
            let followSucceeded = false;
            const followFailureReasons = [];
            for (const u of uid) {
                if (hasFollowing(this.attentionList, u)) {
                    if (!followFailed) { actions.follow.status = 'success'; actions.follow.reason = '当前已关注'; }
                    followSucceeded = true;
                    continue;
                }
                const followResult = await bili.autoAttentionDetailed(u);
                appendAttempts(actions.follow, followResult);
                status = followResult.internalCode;
                if (status === 6) {
                    if (!followFailed) { actions.follow.status = 'success'; actions.follow.reason = '当前已关注'; }
                    followSucceeded = true;
                    continue;
                }
                if (status) {
                    followFailed = true;
                    log.warn('抽奖信息', `dyid: ${dyid}, uid: ${u}`);
                    fail(2000 + status, actions.follow, followResult, '关注');
                    followFailureReasons.push(actions.follow.reason);
                    continue;
                }
                if (is_not_create_partition !== true) {
                    if (permanentActionErrors.follow_group) {
                        followFailed = true;
                        actions.follow.status = 'failed';
                        actions.follow.code = permanentActionErrors.follow_group.code;
                        actions.follow.reason = `关注分组失败：${permanentActionErrors.follow_group.reason}；本轮后续关注分组请求已停止`;
                        followFailureReasons.push(actions.follow.reason);
                        continue;
                    }
                    const partitionResult = await bili.movePartitionDetailed(u, this.tagid);
                    appendAttempts(actions.follow, partitionResult);
                    if (partitionResult.internalCode) {
                        followFailed = true;
                        if (Number(partitionResult.providerCode) === 22105) {
                            permanentActionErrors.follow_group = {
                                code: partitionResult.internalCode,
                                providerCode: 22105,
                                reason: partitionResult.reason || '请先公开关注后再添加分组'
                            };
                        }
                        log.warn('抽奖信息', `dyid: ${dyid}, uid: ${u} tagid: ${this.tagid}`);
                        fail(3001, actions.follow, partitionResult, '关注分组');
                        followFailureReasons.push(actions.follow.reason);
                        continue;
                    }
                }
                if (!followFailed) { actions.follow.status = 'success'; actions.follow.reason = '关注成功'; }
                followSucceeded = true;
            }
            if (followSucceeded) successCount += 1;
            if (followFailed) { actions.follow.status = 'failed'; actions.follow.reason = [...new Set(followFailureReasons)].join('；') || actions.follow.reason; }
        }

        /* 点赞：不再由重复参与检查开关控制。 */
        if (!commentOnly && dyid) {
            if (is_liked) {
                actions.like.status = 'success';
                actions.like.reason = '当前已点赞';
                successCount += 1;
            } else {
                const likeResult = await retryDetailed(5, [3], () => bili.autolikeDetailed(dyid));
                appendAttempts(actions.like, likeResult);
                status = likeResult.internalCode;
                if (status === 4) {
                    actions.like.status = 'success';
                    actions.like.reason = '当前已点赞';
                    successCount += 1;
                } else if (status) {
                    log.warn('抽奖信息', `dyid: ${dyid}`);
                    fail(4000 + status, actions.like, likeResult, '点赞');
                } else {
                    actions.like.status = 'success';
                    actions.like.reason = '点赞成功';
                    successCount += 1;
                }
            }
        }

        /* 转发 */
        if (!commentOnly && dyid && failFromPermanentError('relay', actions.relay, '转发')) {
            log.warn('抽奖信息', `dyid: ${dyid}, 转发接口本轮已停止：B站返回 ${permanentActionErrors.relay.providerCode}`);
        } else if (!commentOnly && dyid) {
            actions.relay.actualText = String(relay_chat || '').slice(0, 233);
            if (!actions.relay.actualText) actions.relay.source = 'empty';
            const relayResult = await retryDetailed(5, [3, 4], () => bili.autoRelayDetailed(global_var.get('myUID'), dyid, actions.relay.actualText, ctrl));
            appendAttempts(actions.relay, relayResult);
            status = relayResult.internalCode;
            if (status) {
                log.warn('抽奖信息', `dyid: ${dyid}`);
                fail(5000 + status, actions.relay, relayResult, '转发');
            } else {
                actions.relay.status = 'success';
                actions.relay.reason = actions.relay.actualText ? '转发成功' : '使用空附言转发成功';
                successCount += 1;
            }
        }

        return finish(firstFailureCode || status);
    }
}


module.exports = { Monitor, getMatchedBlockwords, blockwordReason };
