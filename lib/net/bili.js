const GlobalVar = require('../data/global_var');
const { strToJson, log, ocr, hasEnv } = require('../utils');
const { send } = require('./http');
const { loadFollowingList } = require('./followings');
const API = require('./api.bili');

class Line {
    /**
     * 智能线路切换
     * @typedef {boolean} iSwitch 是否切换
     * @typedef {string} Msg 信息说明
     * @typedef {[iSwitch, any, Msg]} ResResult
     * @param {string} line_name
     * @param {Array<(...arg) => Promise<ResResult | string>>} requests
     * @param {(responseText: string) => ResResult} [pub_handler]
     */
    constructor(line_name, requests, pub_handler) {
        this.line_name = line_name;
        this.requests = requests;
        this.valid_line = 0;
        this.switch_times = 0;
        if (pub_handler) this.pub_handler = pub_handler;
        /**
         * @type {ResResult}
         */
        this.res_result = [false, null, ''];
    }

    /**
     * 切换线路
     * @returns {boolean}
     */
    switchLine() {
        const { valid_line, requests: { length }, switch_times } = this;
        this.valid_line = (valid_line + 1) % length;
        this.switch_times += 1;
        if (switch_times > length) {
            return false;
        } else {
            return true;
        }
    }

    /**
     * 存储当前有效线路
     * @param {number} line
     */
    storeLine(line) {
        this.valid_line = line;
        this.switch_times = 0;
    }

    /**
     * 启动
     * @param  {...any} args
     * @returns {Promise<any>}
     */
    async run(...args) {
        const
            { line_name, requests, valid_line } = this,
            resp = await requests[valid_line](...args);
        if (typeof resp === 'string') {
            this.res_result = this.pub_handler(resp);
        } else {
            this.res_result = resp;
        }
        const [i_switch, value, msg] = this.res_result;
        if (!i_switch) {
            log.info(line_name, msg);
            this.storeLine(valid_line);
            return value;
        }
        if (this.switchLine()) {
            log.warn(line_name, msg);
            log.warn(line_name, `切换线路(${valid_line + 1}/${requests.length})`);
            return await this.run();
        } else {
            log.error(line_name, msg);
            log.error(line_name, '所有备用线路均连接失败');
            return value;
        }
    }
}

/**
 * GET请求
 * @param {import('./http').RequestOptions} param0
 * @returns {Promise<string>}
 */
function get({ url, config, contents, query }) {
    return new Promise((resolve) => {
        send({
            url,
            method: 'GET',
            config,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'cookie': GlobalVar.get('cookie')
            },
            query,
            contents,
            success: res => resolve(log.debug_return(url, res.body)),
            failure: err => resolve(log.debug_return(url, err))
        });
    });
}

/**
 * POST请求
 * @param {import('./http').RequestOptions} param0
 * @returns {Promise<string>}
 */
function post({ url, config, contents, query }) {
    return new Promise((resolve) => {
        send({
            url,
            method: 'POST',
            config,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'cookie': GlobalVar.get('cookie')
            },
            query,
            contents,
            success: res => resolve(log.debug_return(url, res.body)),
            failure: err => resolve(log.debug_return(url, err))
        });
    });
}

function cleanActionText(value) {
    return String(value || '')
        .replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}

function postDetailed({ url, config, contents, query }) {
    return new Promise((resolve) => {
        send({
            url,
            method: 'POST',
            config,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'cookie': GlobalVar.get('cookie')
            },
            query,
            contents,
            success: res => resolve({ ok: true, body: String(res.body || ''), httpStatus: Number(res.statusCode) || 200 }),
            failure: (error, detail = {}) => resolve({
                ok: false,
                body: String(detail.body || ''),
                httpStatus: Number(detail.httpStatus) || null,
                errorType: detail.errorType || 'network',
                transportCode: cleanActionText(detail.transportCode),
                errorMessage: cleanActionText(error)
            })
        });
    });
}

function getDetailed({ url, config, contents, query }) {
    return new Promise((resolve) => {
        send({
            url,
            method: 'GET',
            config,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'cookie': GlobalVar.get('cookie')
            },
            query,
            contents,
            success: res => resolve({ ok: true, body: String(res.body || ''), httpStatus: Number(res.statusCode) || 200 }),
            failure: (error, detail = {}) => resolve({
                ok: false,
                body: String(detail.body || ''),
                httpStatus: Number(detail.httpStatus) || null,
                errorType: detail.errorType || 'network',
                transportCode: cleanActionText(detail.transportCode),
                errorMessage: cleanActionText(error)
            })
        });
    });
}

function detailedResult(action, response, mappings = {}, options = {}) {
    const occurredAt = new Date().toISOString();
    const providerCodeOf = value => {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const code = Number(value);
        return Number.isFinite(code) ? code : null;
    };
    if (!response.ok) {
        const status = response.httpStatus;
        const httpMessage = status === 429 ? '请求过于频繁' : status >= 500 ? 'B站服务暂时不可用' : status ? `HTTP状态码 ${status}` : response.errorMessage;
        let providerCode = null;
        let providerMessage = null;
        try {
            const parsed = JSON.parse(response.body || '');
            providerCode = providerCodeOf(parsed?.code);
            providerMessage = cleanActionText(parsed?.message);
        } catch (_) { /* HTTP error bodies are often HTML or plain text */ }
        const providerReason = providerCode === null ? '' : `；B站返回 ${providerCode}${providerMessage ? `（${providerMessage}）` : ''}`;
        return {
            action, status: 'failed', internalCode: 1, providerCode, providerMessage: providerMessage || null,
            errorType: response.errorType || 'network', httpStatus: status || null,
            transportCode: response.transportCode || null,
            retryable: response.errorType === 'network' || response.errorType === 'timeout' || [408, 425, 429, 500, 502, 503, 504].includes(status),
            reason: status ? `HTTP ${status}（${httpMessage}）${providerReason}` : `${response.errorType === 'timeout' ? '请求超时' : '网络错误'}${response.transportCode ? ` ${response.transportCode}` : ''}${response.errorMessage ? `（${response.errorMessage}）` : ''}`,
            occurredAt
        };
    }
    let parsed;
    try { parsed = JSON.parse(response.body); }
    catch (_) {
        return {
            action, status: 'failed', internalCode: 1, providerCode: null, providerMessage: null,
            errorType: 'parse', httpStatus: response.httpStatus || null, transportCode: null, retryable: false,
            reason: `B站响应格式异常${cleanActionText(response.body) ? `（${cleanActionText(response.body)}）` : ''}`,
            occurredAt
        };
    }
    const parsedProviderCode = parsed && typeof parsed === 'object' ? providerCodeOf(parsed.code) : null;
    if (parsedProviderCode === null) {
        return {
            action, status: 'failed', internalCode: 1, providerCode: null, providerMessage: null,
            errorType: 'parse', httpStatus: response.httpStatus || null, transportCode: null, retryable: false,
            reason: 'B站响应缺少有效错误码', occurredAt
        };
    }
    const providerCode = parsedProviderCode;
    const mapped = mappings[providerCode] || {};
    const providerMessage = cleanActionText(parsed.message || mapped.message || '');
    const success = providerCode === 0;
    const status = success ? 'success' : mapped.status || 'failed';
    const mappedInternalCode = Number(mapped.internalCode);
    return {
        action, status, internalCode: success ? 0 : Number.isFinite(mappedInternalCode) ? mappedInternalCode : 1,
        providerCode, providerMessage: providerMessage || null,
        errorType: success || status === 'already_done' ? null : mapped.errorType || 'bili_api',
        httpStatus: response.httpStatus || null, transportCode: null,
        retryable: Boolean(options.retryableCodes?.includes(providerCode)),
        reason: success ? mapped.message || '操作成功' : providerMessage ? `B站返回 ${providerCode}（${providerMessage}）` : `B站返回错误码 ${providerCode}`,
        captchaUrl: mapped.status === 'challenge' ? cleanActionText(parsed.data?.url) : null,
        occurredAt
    };
}

function logDetailed(context, result, successMessage) {
    if (result.status === 'success' || result.status === 'already_done') log.info(context, successMessage || result.reason);
    else if (result.status !== 'challenge') log.error(context, result.reason);
    return result;
}

function reserveLotteryDetailedResult(response, reserveId) {
    const result = detailedResult('reserve_lottery', response, {
        0: { message: '预约成功' },
        7604003: { internalCode: 0, status: 'already_done', message: '重复预约' }
    });
    result.targetId = String(reserveId);
    result.attempts = [{ ...result, attemptNo: 1 }];
    return result;
}

function collectArticleDynamicLinks(value, links = []) {
    if (typeof value === 'string') {
        if (/(?:bilibili\.com\/opus\/|t\.bilibili\.com\/|b23\.tv\/)[a-zA-Z0-9]+/.test(value)) {
            links.push(value);
        }
        return links;
    }
    if (value instanceof Array) {
        value.forEach(item => collectArticleDynamicLinks(item, links));
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(item => collectArticleDynamicLinks(item, links));
    }
    return links;
}

/**
 * 网络请求
 */
const bili_client = {
    collectArticleDynamicLinks,
    /**
     * 判断是否成功登录
     * @returns {Promise<Object?>}
     */
    async getMyinfo() {
        const
            responseText = await get({
                url: API.SPACE_MYINFO
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            GlobalVar.set('myUNAME', res.data.name);
            return res.data;
        } else {
            return null;
        }
    },
    /**
     * 帐号统计
     * @returns {Promise<Object?>}
     */
    async getStat() {
        const
            responseText = await get({
                url: API.WEB_INTERFACE_NAV_STAT
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            return res.data;
        } else {
            return null;
        }
    },
    /**
     * 获取被at的信息
     * @typedef AtInfo
     * @property {number} at_time
     * @property {string} up_uname
     * @property {string} business
     * @property {string} source_content
     * @property {string} url
     * @returns {Promise<AtInfo[]>}
     */
    async getMyAtInfo() {
        const
            responseText = await get({
                url: API.MSGFEED_AT
            }),
            res = strToJson(responseText);
        let atInfo = [];
        if (res.code === 0) {
            const items = res.data.items;
            if (items.length !== 0) {
                items.forEach(i => {
                    const { at_time, item, user } = i, { nickname: up_uname } = user, { business, uri: url, source_content } = item;
                    atInfo.push({
                        at_time,
                        up_uname,
                        business,
                        source_content,
                        url
                    });
                });
            }
            return atInfo;
        } else {
            return atInfo;
        }
    },
    /**
     * 获取未读信息数量
     * @returns {Promise<{at: number, reply: number}>}
     */
    async getUnreadNum() {
        const
            responseText = await get({
                url: API.MSGFEED_UNREAD
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('获取未读信息', '成功');
            return res.data;
        } else {
            log.error('获取未读信息', `失败\n${responseText}`);
            return {};
        }
    },
    /**
     * 获取一页回复
     * @returns {Promise<Array<{nickname: string, source: string, uri: string, timestamp: number}>}>}
     */
    async getReplyMsg() {
        const
            responseText = await get({
                url: API.MSGFEED_REPLAY
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            const data = res.data || {},
                items = data.items || [];
            log.info('获取一页回复', `成功(${items.length})`);
            return items
                .filter(it => it.item !== undefined
                    && it.user !== undefined
                    && it.reply_time !== undefined)
                .map(it => {
                    return {
                        nickname: it.user.nickname,
                        source: it.item.source_content,
                        uri: it.item.uri,
                        timestamp: it.reply_time
                    };
                });
        } else {
            log.error('获取一页回复', '失败');
            return [];
        }
    },
    /**
     * 获取一页私信
     * @typedef SessionData
     * @property {string} session_ts
     * @property {number} timestamp
     * @property {number} unread_count
     * @property {number} sender_uid
     * @property {number} talker_id
     * @property {number} msg_seqno
     *
     * @typedef SessionInfo
     * @property {number} has_more
     * @property {SessionData[]} data
     *
     * @param {number} session_type 1 已关注 2 未关注 3 应援团
     * @param {string} [ts_16]
     * @returns {Promise<SessionInfo>}
     */
    async getSessionInfo(session_type, ts_16 = '') {
        const
            responseText = await get({
                url: API.SESSION_SVR_GET_SESSIONS,
                query: {
                    session_type,
                    end_ts: ts_16,
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('获取一页私信(20)', '成功 ' + (ts_16 ? 'end_ts->' + ts_16 : '第一页'));
            /**@type {Array} */
            const
                sessions = res.data.session_list || [],
                has_more = res.data.has_more,
                data = sessions.map(session => {
                    const
                        { session_ts, last_msg, unread_count, talker_id } = session,
                        { timestamp = 0, sender_uid = 0, msg_seqno } = last_msg || {};
                    return { session_ts, timestamp, sender_uid, unread_count, talker_id, msg_seqno };
                });
            return { has_more, data };
        } else if (res.code === 2) {
            log.error('获取私信', 'API抽风...请再次尝试');
            return { has_more: 0, data: [] };
        } else {
            log.error('获取私信', `失败\n${responseText}`);
            return { has_more: 0, data: [] };
        }
    },
    /**
     * 获取私信细节
     * @param {number} talker_id
     * @param {number} size
     */
    async fetch_session_msgs(talker_id, size) {
        const
            responseText = await get({
                url: API.FETCH_SESSION_MSGS,
                query: {
                    talker_id,
                    session_type: 1,
                    size
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            const msgs = res.data.messages;
            if (msgs instanceof Array) {
                log.info('私信细节', `${talker_id}有${size}条未读私信`);
                return msgs.filter(it => ![8].includes(it.msg_source)).map(it => it.content).join('\n');
            } else {
                log.warn('私信细节', `${talker_id}无私信`);
            }
        }
        log.error('私信细节', '获取失败');
        return '';
    },
    /**
     * 获取未读私信数量
     * @returns {Promise<{ unfollow_unread: number, follow_unread: number }>}
     */
    async getUnreadSessionNum() {
        const
            responseText = await get({
                url: API.SESSION_SVR_SINGLE_UNREAD
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            const { unfollow_unread = 0, follow_unread = 0 } = res.data;
            log.info('获取未读私信', `成功 已关注未读数: ${follow_unread}, 未关注未读数 ${unfollow_unread}`);
            return { unfollow_unread, follow_unread };
        } else {
            log.error('获取未读私信', `失败\n${responseText}`);
            return null;
        }
    },
    /**
     * 私信已读
     * @param {number} talker_id
     * @param {number} session_type
     * @param {number} msg_seqno
     */
    async updateSessionStatus(talker_id, session_type, msg_seqno) {
        const
            responseText = await post({
                url: API.SESSION_SVR_UPDATE_ACK,
                config: {
                    retry: false
                },
                contents: {
                    talker_id,
                    session_type,
                    ack_seqno: msg_seqno,
                    csrf_token: GlobalVar.get('csrf'),
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('私信已读', `成功 -> talker_id: ${talker_id}`);
        } else {
            log.error('私信已读', `失败 -> talker_id: ${talker_id}\n${responseText}`);
        }
    },
    /**
     * 获取关注列表
     * @param {number} uid
     * @returns {Promise<Set<string> | null>}
     */
    async getAttentionList(uid) {
        try {
            const result = await loadFollowingList({
                uid,
                accountId: process.env.NUMBER,
                fetchPage: async (page, pageSize) => {
                    const responseText = await get({
                        url: API.RELATION_FOLLOWINGS,
                        query: {
                            vmid: uid,
                            pn: page,
                            ps: pageSize,
                            order: 'desc'
                        }
                    });
                    try {
                        return JSON.parse(responseText);
                    } catch (_) {
                        throw new Error('B站关注接口响应不是有效 JSON');
                    }
                }
            });
            if (result.source === 'cache') {
                const ageMinutes = Math.max(1, Math.round(result.ageMs / 60000));
                log.warn('获取关注列表', `在线获取失败，使用缓存(${ageMinutes}分钟前，共${result.items.size}人)`);
            } else {
                log.info('获取关注列表', `成功，共${result.items.size}人`);
                if (result.cacheError) log.warn('关注列表缓存', `写入失败: ${result.cacheError.message}`);
            }
            return result.items;
        } catch (error) {
            log.error('获取关注列表', error.message);
            return null;
        }
    },
    /**
     * @param {string} short_id
     * @returns {Promise<string>}
     */
    async shortDynamicIdToDyid(short_id) {
        return get({
            url: API.SHORTLINK.replace('{{short_id}}', short_id),
            config: {
                redirect: false,
            }
        }).then(a => {
            const dyid = (a.match(/[0-9]{18,}/) || [])[0];
            log.info('短连接转换', `${short_id} -> ${dyid}`);
            return dyid;
        });
    },
    _getOneDynamicByDyid: new Line(
        '获取一个动态的细节',
        [
            (id) => get({
                url: API.X_POLYMER_WEB_DYNAMIC_V1_DETAIL,
                config: { retry: false },
                query: {
                    id,
                    features: 'itemOpusStyle'
                }
            }),
        ]
        , responseText => {
            const httpStatus = responseText.match(/^\[响应错误\]HTTP状态码:(\d+)/)?.[1];
            if (httpStatus === '412') {
                return [false, null, '触发HTTP风控(code=412)，停止继续请求动态详情'];
            }
            if (httpStatus) {
                return [false, undefined, `动态详情请求失败(HTTP ${httpStatus})`];
            }
            const
                res = strToJson(responseText),
                { code, data } = res;
            switch (code) {
                case 0:
                    return [false, data, 'ok'];
                case -352:
                case -412:
                    return [false, null, `触发风控(code=${code})，停止继续请求动态详情`];
                default:
                    return [true, undefined, `获取动态数据出错:\n${responseText}`];
            }
        }),
    /**
     * 获取一个动态的细节
     * @param {string} dynamic_id
     * @return {Promise<JSON>} 失败返回undefined
     */
    async getOneDynamicByDyid(dynamic_id) {
        return this._getOneDynamicByDyid.run(dynamic_id);
    },
    /**
     * 获取当前账号关注用户的综合动态流
     * @param {string} [offset]
     * @returns {Promise<string>}
     */
    getFollowFeed(offset = '') {
        const query = {
            timezone_offset: -480,
            type: 'all'
        };
        if (offset) query.offset = offset;
        return get({
            url: API.X_POLYMER_WEB_DYNAMIC_V1_FEED_ALL,
            query
        });
    },
    /**
     * 获取一组动态的信息
     * @param {number} host_uid 被查看者的uid
     * @param {string} offset_dynamic_id 此动态偏移量 初始为 0
     * @returns {Promise<string>}
     */
    getOneDynamicInfoByUID(host_mid, offset) {
        /* 鉴别工作交由modifyDynamicRes完成 */
        /* 新版似乎没有 visitor_uid */
        return get({
            url: API.X_POLYMER_WEB_DYNAMIC_V1_FEED_SPACE,
            query: {
                host_mid,
                offset,
                features: 'itemOpusStyle'
            },
            config: {
                retry: false
            }
        });
    },
    /**
     * 通过tag名获取tag的id
     * @param {string} tag_name
     * tag名
     * @returns {Promise<number | -1>}
     * 正确:tag_ID
     * 错误:-1
     */
    async getTagIDByTagName(tag_name) {
        const
            responseText = await get({
                url: API.TAG_INFO,
                query: {
                    tag_name
                }
            }),
            res = strToJson(responseText);
        if (res.code !== 0) {
            log.error('获取TagID', '失败');
            return -1;
        } else {
            return res.data.tag_id;
        }
    },
    /**
     * 获取tag下的热门动态以及一条最新动态
     * @param {number} tagid
     * @returns {Promise<string>}
     */
    getHotDynamicInfoByTagID(tagid) {
        return get({
            url: API.TOPIC_SVR_TOPIC_NEW,
            query: {
                topic_id: tagid
            }
        });
    },
    /**
     * 获取tag下的最新动态
     * @param {string} tagname
     * @param {string} offset
     * @returns {Promise<string>}
     */
    getOneDynamicInfoByTag(tagname, offset) {
        return get({
            url: API.TOPIC_SVR_TOPIC_HISTORY,
            query: {
                topic_name: tagname,
                offset_dynamic_id: offset
            },
            config: {
                retry: false
            }
        });
    },
    /**
     * 搜索专栏
     * @param {string} keyword
     * @return {Promise<Array<{pub_time: number, id: number}>>}
     */
    async searchArticlesByKeyword(keyword) {
        const
            responseText = await get({
                url: API.WEB_INTERFACE_SEARCH_TYPE,
                query: {
                    keyword,
                    page: 1,
                    order: 'pubdate',
                    search_type: 'article'
                }
            }),
            res = JSON.parse(responseText);
        if (res.code === 0) {
            let cv_arr = [];
            try {
                log.info('搜索专栏', '成功 关键词: ' + keyword);
                cv_arr = res.data.result.map(it => {
                    return {
                        pub_time: it.pub_time,
                        id: it.id
                    };
                });
            } catch (error) {
                log.error('搜索专栏', '失败 原因:\n' + responseText);
                cv_arr = [];
            }
            return cv_arr;
        } else {
            log.error('搜索专栏', '失败 原因:\n' + responseText);
            return [];
        }
    },
    /**
     * 获取指定用户最新发布的专栏
     * @param {number | string} mid
     * @param {number} limit
     * @return {Promise<Array<{pub_time: number, id: number}> | null>}
     */
    async getArticlesByUID(mid, limit) {
        const responseText = await get({
                url: API.SPACE_ARTICLE,
                query: {
                    mid,
                    pn: 1,
                    ps: limit,
                    sort: 'publish_time'
                }
            }),
            res = strToJson(responseText);
        if (res.code !== 0 || !(res.data?.articles instanceof Array)) {
            log.error('获取用户专栏', `失败 UID:${mid} 状态:${res.code ?? 'unknown'}`);
            return null;
        }
        return res.data.articles.map(it => ({
            pub_time: it.publish_time,
            id: it.id
        }));
    },
    /**
     * 获取专栏内容
     * @param {number} cv
     * @returns {Promise<string | null>}
     */
    async getOneArticleByCv(cv) {
        const responseText = await get({
                url: API.ARTICLE_VIEW,
                query: { id: cv },
                config: { retry: false }
            }),
            res = strToJson(responseText);
        if (res.code !== 0 || typeof res.data?.content !== 'string' || !res.data.content.trim()) {
            const status = res.code ?? responseText.match(/HTTP状态码:(\d+)/)?.[1] ?? 'unknown';
            log.error('获取专栏正文', `失败 专栏:${cv} 状态:${status} ${res.message || ''}`.trim());
            return null;
        }
        const links = collectArticleDynamicLinks(res.data.opus);
        return [res.data.content, ...links].join('\n');
    },
    /**
     * 获取粉丝数的所有有效方式
     */
    _getUserInfo: new Line('获取粉丝数', [
        /**
         * 线路一
         * @param {number} uid
         * @returns {Promise<string>}
         */
        (uid) => get({
            url: API.WEB_INTERFACE_CARD,
            query: {
                mid: uid,
                photo: false
            },
            config: {
                retry: false
            }
        }),
        /**
         * 线路二
         * @param {number} uid
         * @returns {Promise<string>}
         */
        (uid) => get({
            url: API.RELATION_STAT,
            query: {
                vmid: uid
            }
        }),
        /**
         * 线路三
         * @param {number} uid
         * @returns {Promise<string>}
         */
        (uid) => get({
            url: 'https://tenapi.cn/bilibilifo/',
            query: {
                uid
            }
        })
    ], responseText => {
        const res = strToJson(responseText);
        if (res.code === 0) {
            return [false, res.data.follower, 'ok'];
        } else {
            return [true, -1, `出错 可能是访问过频繁\n${responseText}`];
        }
    }),
    /**
     * 获取粉丝数
     * @param {number} uid
     * @returns {Promise<number | -1>}
     */
    getUserInfo(uid) {
        return this._getUserInfo.run(uid);
    },
    /**
     * 获取开奖信息
     * @param {string} dyid
     * 动态id
     * @typedef LotteryNotice
     * @property {number} ts
     * @returns {Promise<LotteryNotice>} 开奖时间
     */
    async getLotteryNotice(dyid) {
        const
            responseText = await get({
                url: API.LOTTERY_SVR_LOTTERY_NOTICE,
                query: {
                    dynamic_id: dyid
                }
            }),
            res = strToJson(responseText);
        switch (res.code) {
            case 0:
                return {
                    ts: res.data.lottery_time
                };
            case -9999:
                log.warn('获取开奖信息', `${dyid}已撤销抽奖`);
                return {
                    ts: -9999
                };
            default:
                log.error('获取开奖信息', `${dyid}失败\n${responseText}`);
                return {
                    ts: -1
                };
        }
    },
    _autoAttention: new Line('自动关注', [
        (uid) => post({
            url: API.RELATION_MODIFY,
            config: {
                retry: false
            },
            contents: {
                fid: uid,
                act: 1,
                re_src: 0,
                csrf: GlobalVar.get('csrf')
            }
        }),
        (uid) => post({
            url: API.FEED_SETUSERFOLLOW,
            contents: {
                type: 1,
                follow: uid,
                csrf: GlobalVar.get('csrf')
            }
        }),
        (uid) => post({
            url: API.RELATION_BATCH_MODIFY,
            contents: {
                fids: uid,
                act: 1,
                re_src: 1,
                csrf: GlobalVar.get('csrf')
            }
        })
    ], responseText => {
        const res = strToJson(responseText);
        switch (res.code) {
            case 0:
                return [false, 0, '关注+1'];
            case 22002:
                return [false, 2, '您已被对方拉入黑名单'];
            case 22003:
                return [false, 3, '黑名单用户无法关注'];
            case 22015:
                return [false, 4, '账号异常'];
            case 22009:
                return [false, 5, '关注已达上限'];
            case 22014:
                return [false, 6, '已经关注用户，无法重复关注'];
            default:
                return [true, 1, `未知错误\n${responseText}`];
        }
    }),
    /**
     * 之前不检查是否重复关注
     * 自动关注
     * 并转移分组
     * @param {Number} uid
     * 被关注者的UID
     * @returns {Promise<number>}
     * - 成功 0
     * - 未知错误 1
     * - 您已被对方拉入黑名单 2
     * - 黑名单用户无法关注 3
     * - 账号异常 4
     * - 关注已达上限 5
     * - 已经关注用户 6
     */
    async autoAttention(uid) {
        return (await this.autoAttentionDetailed(uid)).internalCode;
    },
    async autoAttentionDetailed(uid) {
        const requests = [
            { url: API.RELATION_MODIFY, config: { retry: false }, contents: { fid: uid, act: 1, re_src: 0, csrf: GlobalVar.get('csrf') } },
            { url: API.FEED_SETUSERFOLLOW, contents: { type: 1, follow: uid, csrf: GlobalVar.get('csrf') } },
            { url: API.RELATION_BATCH_MODIFY, contents: { fids: uid, act: 1, re_src: 1, csrf: GlobalVar.get('csrf') } }
        ];
        const mappings = {
            22002: { internalCode: 2, message: '您已被对方拉入黑名单' },
            22003: { internalCode: 3, message: '黑名单用户无法关注' },
            22015: { internalCode: 4, message: '账号异常' },
            22009: { internalCode: 5, message: '关注已达上限' },
            22014: { internalCode: 6, message: '已经关注用户', status: 'already_done' }
        };
        const attempts = [];
        let result;
        for (let index = 0; index < requests.length; index += 1) {
            result = detailedResult('follow', await postDetailed(requests[index]), mappings);
            result.targetId = String(uid);
            result.line = index + 1;
            attempts.push({ ...result, attemptNo: index + 1 });
            if (result.status === 'success' || result.status === 'already_done' || result.internalCode !== 1) break;
            if (index < requests.length - 1) log.warn('自动关注', `${result.reason}，切换线路(${index + 1}/${requests.length})`);
        }
        result.attempts = attempts;
        return logDetailed('自动关注', result, result.status === 'already_done' ? '当前已关注' : '关注成功');
    },
    /**
     * 移动分区
     * @param {number} uid
     * @param {number} tagid 关注分区的ID
     * @returns {Promise<number>}
     * - 成功 0
     * - 失败 1
     */
    async movePartition(uid, tagid) {
        return (await this.movePartitionDetailed(uid, tagid)).internalCode;
    },
    async movePartitionDetailed(uid, tagid) {
        const result = detailedResult('follow_group', await postDetailed({
            url: API.RELATION_TAGS_ADDUSERS,
            contents: {
                fids: uid,
                tagids: tagid,
                csrf: GlobalVar.get('csrf')
            }
        }), { 22105: { internalCode: 1, message: '请先公开关注后再添加分组' } });
        result.targetId = String(uid);
        result.attempts = [{ ...result, attemptNo: 1 }];
        return logDetailed('移动分区', result, 'UP主分区移动成功');
    },
    /**
     * 取消关注
     * @param {number} uid
     * @returns {Promise<boolean>}
     */
    async cancelAttention(uid) {
        const
            responseText = await post({
                url: API.RELATION_MODIFY,
                config: {
                    retry: false
                },
                contents: {
                    fid: uid,
                    act: 2,
                    re_src: 0,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            res = strToJson(responseText);
        if (res.code === 0) {
            log.info('自动取关', `取关成功(${uid})`);
            return true;
        } else {
            log.error('自动取关', `取关失败(${uid})\n${responseText}`);
            return false;
        }
    },
    /**
     * 动态自动点赞
     * @param {string} dyid
     * @returns {Promise<number>}
     * - 成功 0
     * - 未知错误 1
     * - 点赞异常 2
     * - 点赞频繁 3
     * - 已赞过 4
     * - 账号异常，点赞失败 5
     */
    async autolike(dyid) {
        return (await this.autolikeDetailed(dyid)).internalCode;
    },
    async autolikeDetailed(dyid) {
        const result = detailedResult('like', await postDetailed({
            url: API.DYNAMIC_LIKE_THUMB,
            contents: {
                uid: GlobalVar.get('myUID'),
                dynamic_id: dyid,
                up: 1,
                csrf: GlobalVar.get('csrf')
            }
        }), {
            1000113: { internalCode: 2, message: '点赞异常' },
            1000001: { internalCode: 3, message: '点赞频繁' },
            65006: { internalCode: 4, message: '已赞过', status: 'already_done' },
            4128014: { internalCode: 5, message: '账号异常，点赞失败' }
        }, { retryableCodes: [1000001] });
        result.targetId = String(dyid);
        result.attempts = [{ ...result, attemptNo: 1 }];
        return logDetailed('自动点赞', result, result.status === 'already_done' ? '当前已点赞' : '点赞成功');
    },
    /**
     * 转发前应查看是否重复转发
     * 自动转发
     * @param {Number} uid
     * 自己的UID
     * @param {string} dyid
     * @param {string} [msg]
     * 动态的ID
     * @returns {Promise<number>}
     * - 成功 0
     * - 未知错误 1
     * - 该动态不能转发分享 2
     * - 请求数据发生错误，请刷新或稍后重试 3
     * - 操作太频繁了，请稍后重试 4
     * - 源动态禁止转发 5
     * - 等级不足无法发送 6
     */
    async autoRelay(uid, dyid, msg = '转发动态', ctrl = '[]') {
        return (await this.autoRelayDetailed(uid, dyid, msg, ctrl)).internalCode;
    },
    async autoRelayDetailed(uid, dyid, msg = '转发动态', ctrl = '[]') {
        msg = String(msg || '').slice(0, 233);
        const result = detailedResult('relay', await postDetailed({
            url: API.DYNAMIC_REPOST_REPOST,
            config: { retry: false },
            contents: {
                uid: `${uid}`,
                dynamic_id: dyid,
                content: msg,
                ctrl,
                csrf: GlobalVar.get('csrf')
            }
        }), {
            1101004: { internalCode: 2, message: '该动态不能转发分享' },
            2201116: { internalCode: 3, message: '请求数据发生错误，请刷新或稍后重试' },
            1101008: { internalCode: 4, message: '操作太频繁了，请稍后重试' },
            4126117: { internalCode: 5, message: '源动态禁止转发' },
            4126021: { internalCode: 6, message: '等级不足无法发送，快去努力升级吧' }
        }, { retryableCodes: [2201116, 1101008] });
        result.targetId = String(dyid);
        result.attempts = [{ ...result, attemptNo: 1 }];
        return logDetailed('转发动态', result, '成功转发一条动态');
    },
    /**
     * 预约抽奖
     * @param {string} reserve_id
     * @returns
     */
    async reserve_lottery(reserve_id) {
        const result = reserveLotteryDetailedResult(await postDetailed({
            url: API.DYNAMIC_MIX_RESERVE_ATTACH_CARD_BUTTON,
            contents: {
                cur_btn_status: '1',
                reserve_id,
                csrf: GlobalVar.get('csrf')
            }
        }), reserve_id);
        logDetailed('预约抽奖', result, result.status === 'already_done' ? '重复预约' : '预约成功');
        return result.internalCode;
    },
    /**
     * @typedef Picture
     * @property {string} img_src
     * @property {number} img_width
     * @property {number} img_height
     * 发布一条动态
     * @param { string | Picture[] } content
     * @return {Promise<boolean>} isError true
     */
    async createDynamic(content) {
        let
            contents = {
                csrf: GlobalVar.get('csrf'),
                extension: '{"emoji_type":1,"from":{"emoji_type":1},"flag_cfg":{}}',
            },
            url = '';
        if (content instanceof Array) {
            url = API.DYNAMIC_SVR_CREATE_DRAW;
            contents = {
                ...contents,
                biz: 3,
                category: 3,
                pictures: JSON.stringify(content)
            };
        } else {
            url = API.DYNAMIC_SVR_CREATE;
            contents = {
                ...contents,
                type: 4,
                content,
            };
        }
        const responseText = await post({
            url,
            contents,
        });
        if (/^{"code":0/.test(responseText)) {
            log.info('发布动态', `成功创建一条随机内容的动态\n${JSON.stringify(content)}\n`);
            return false;
        } else {
            log.error('发布动态', `发布动态失败\n${JSON.stringify(content)}\n${responseText}`);
            return true;
        }
    },
    _getTopRcmd: new Line('获取推荐', [
        () => get({
            url: API.TOP_RCMD
        }),
        () => get({
            url: API.TOP_FEED_RCMD
        })
    ], responseText => {
        const res = strToJson(responseText);
        if (res.code === 0) {
            return [false, res.data.item.map(it => {
                return [it.owner.mid, it.id];
            }), '成功'];
        } else {
            return [true, [], `获取推荐失败\n${responseText}`];
        }
    }),
    /**
     * 获取推荐
     * @returns {Promise<Array<[number, number]>>}
     */
    async getTopRcmd() {
        return this._getTopRcmd.run();
    },
    /**
     * 分享视频
     * @param {number} uid
     * @param {number} aid
     * @return {Promise<boolean>} isError true
     */
    async shareVideo(uid, aid, content = '分享视频') {
        const result = await this.shareVideoDetailed(uid, aid, content);
        if (result.status === 'success') log.info('转发视频', `成功转发视频(av${aid})`);
        else if (result.status === 'skipped') log.warn('转发视频', `该视频当前不可分享(av${aid})`);
        else log.error('转发视频', `分享 av${aid} 失败：${result.reason}`);
        return result.status === 'failed';
    },
    /**
     * 分享视频并返回 B 站真实错误信息。
     * @param {number} uid
     * @param {number} aid
     */
    async shareVideoDetailed(uid, aid, content = '分享视频') {
        const response = await postDetailed({
            url: API.DYNAMIC_REPOST_SHARE,
            contents: {
                platform: 'pc',
                uid,
                type: 8,
                content: String(content || ''),
                repost_code: 20000,
                rid: aid,
                csrf_token: GlobalVar.get('csrf')
            }
        });
        const result = detailedResult('video_share', response, {
            0: { message: '分享成功' },
            1101015: { status: 'skipped', internalCode: 1, message: '该视频当前不可分享' }
        });
        return { ...result, targetId: String(aid) };
    },
    /**
     * 移除动态
     * @param {string} dyid
     * @returns {Promise<boolean>}
     */
    async rmDynamic(dyid) {
        const responseText = await post({
            url: API.DYNAMIC_SVR_RM_DYNAMIC,
            contents: {
                dynamic_id: dyid,
                csrf: GlobalVar.get('csrf')
            },
            config: {
                retry: false
            }
        });
        if (/^{"code":0/.test(responseText)) {
            log.info('删除动态', `成功删除一条动态(${dyid})`);
            return true;
        } else {
            log.error('删除动态', `删除动态失败(${dyid})\n${responseText}`);
            return false;
        }
    },
    /**
     * 发送评论
     * @param {string} rid
     * cid_str
     * @param {string} msg
     * @param {number} type
     * @param {string} code
     * 1(视频)
     * 11(有图)
     * 17(无图)
     * @returns {Promise<number|string>}
     * - 成功 0
     * - 未知错误 1
     * - 原动态已删除 2
     * - 评论区已关闭 3
     * - 需要输入验证码 4 -> url
     * - 已被对方拉入黑名单 5
     * - 黑名单用户无法互动 6
     * - UP主已关闭评论区 7
     * - 评论内容包含敏感信息 8
     * - 重复评论 9
     * - 帐号未登录 10
     * - 关注UP主7天以上的人可发评论 11
     * - 验证码错误 12
     * - 账号未转正 13
     */
    async sendChat(rid, msg, type, code) {
        const result = await this.sendChatDetailed(rid, msg, type, code);
        return result.status === 'challenge' ? result.captchaUrl : result.internalCode;
    },
    async sendChatDetailed(rid, msg, type, code) {
        const result = detailedResult('comment', await postDetailed({
            url: API.REPLY_ADD,
            contents: { oid: rid, type, message: msg, code, csrf: GlobalVar.get('csrf') }
        }), {
            [-404]: { internalCode: 2, message: '原动态已删除' },
            12002: { internalCode: 3, message: '评论区已关闭' },
            12015: { internalCode: 4, message: '需要输入验证码', status: 'challenge', errorType: 'captcha' },
            12035: { internalCode: 5, message: '已被对方拉入黑名单' },
            12053: { internalCode: 6, message: '黑名单用户无法互动' },
            12061: { internalCode: 7, message: 'UP主已关闭评论区' },
            12016: { internalCode: 8, message: '评论内容包含敏感信息' },
            12051: { internalCode: 9, message: '重复评论' },
            [-101]: { internalCode: 10, message: '帐号未登录' },
            12078: { internalCode: 11, message: '关注UP主7天以上的人可发评论' },
            12073: { internalCode: 12, message: '验证码错误', errorType: 'captcha' },
            [-107]: { internalCode: 13, message: '账号未转正' }
        });
        result.targetId = String(rid);
        result.attempts = [{ ...result, attemptNo: 1 }];
        if (result.status === 'challenge') log.warn('自动评论', result.reason);
        else logDetailed('自动评论', result, `评论成功: ${msg}`);
        return result;
    },
    /**
     * 发送评论 自动识别验证码
     * @param {string} rid
     * cid_str
     * @param {string} msg
     * @param {number} type
     * 1(视频)
     * 11(有图)
     * 17(无图)
     * @returns {Promise<number>}
     * - 成功 0
     * - 未知错误 1
     * - 原动态已删除 2
     * - 评论区已关闭 3
     * - 需要输入验证码 4 -> url
     * - 已被对方拉入黑名单 5
     * - 黑名单用户无法互动 6
     * - UP主已关闭评论区 7
     * - 评论内容包含敏感信息 8
     * - 重复评论 9
     * - 帐号未登录 10
     * - 关注UP主7天以上的人可发评论 11
     * - 验证码错误 12
     */
    async sendChatWithOcr(rid, msg, type) {
        return (await this.sendChatWithOcrDetailed(rid, msg, type)).internalCode;
    },
    async sendChatWithOcrDetailed(rid, msg, type) {
        let need_captcha = false;
        let url = '';
        let result = null;
        const attempts = [];
        do {
            if (need_captcha) {
                const code = await ocr(url);
                if (code) {
                    log.info('验证码识别', `${url} -> ${code}`);
                    result = await bili_client.sendChatDetailed(rid, msg, type, code);
                    attempts.push(...result.attempts.map(item => ({ ...item })));
                    need_captcha = result.internalCode === 12;
                } else {
                    log.error('验证码识别', '失败');
                    result = {
                        action: 'comment', status: 'failed', internalCode: 4, providerCode: null,
                        providerMessage: '验证码识别失败', errorType: 'captcha', httpStatus: null,
                        transportCode: null, retryable: false, reason: '验证码识别失败',
                        targetId: String(rid), occurredAt: new Date().toISOString()
                    };
                    attempts.push({ ...result, attemptNo: attempts.length + 1 });
                    break;
                }
            } else {
                result = await bili_client.sendChatDetailed(rid, msg, type);
                attempts.push(...result.attempts.map(item => ({ ...item })));
                url = result.captchaUrl || '';
                if (result.status === 'challenge' && hasEnv('ENABLE_CHAT_CAPTCHA_OCR')) {
                    need_captcha = true;
                }
            }
        } while (need_captcha);
        result = result || {
            action: 'comment', status: 'failed', internalCode: 1, providerCode: null,
            providerMessage: null, errorType: 'local', httpStatus: null, transportCode: null,
            retryable: false, reason: '评论请求未执行', targetId: String(rid), occurredAt: new Date().toISOString()
        };
        result.attempts = attempts.map((item, index) => ({ ...item, attemptNo: index + 1 }));
        return result;
    },
    /**
     * 查询评论
     * @param {*} rid
     * @param {*} type
     * @returns {Promise<Array<[string,string]>>} [[uname,chat],]
     */
    async getChat(rid, type) {
        const result = await this.getChatDetailed(rid, type);
        if (result.status === 'success') {
            log.info('查询评论', '成功');
            return result.comments;
        }
        log.error('查询评论', result.reason || '读取评论区失败');
        return [];
    },
    async getChatDetailed(rid, type) {
        const response = await getDetailed({
            url: API.V2_REPLAY,
            query: {
                oid: rid,
                type
            }
        });
        const result = detailedResult('comment_read', response, { 0: { message: '读取评论成功' } });
        if (result.status !== 'success') return { ...result, comments: [] };
        let parsed;
        try {
            parsed = JSON.parse(response.body);
            const upmid = parsed.data.upper.mid;
            const replies = Array.isArray(parsed.data.replies) ? parsed.data.replies : [];
            const comments = replies
                .filter(it => it && String(it.mid) !== String(upmid))
                .map(it => [it.member?.uname, it.content?.message])
                .filter(([uname, message]) => String(uname || '').trim() && String(message || '').trim());
            return { ...result, comments, targetId: String(rid) };
        } catch (_) {
            return {
                ...result,
                status: 'failed',
                internalCode: 1,
                providerCode: result.providerCode,
                providerMessage: result.providerMessage,
                errorType: 'parse',
                retryable: false,
                reason: '评论数据结构异常',
                comments: [],
                targetId: String(rid)
            };
        }
    },
    /**
     * 检查分区
     * 不存在指定分区时创建
     * 获取到tagid添加为对象的属性
     * @param {string} [name]
     * @returns {Promise<number>}
     */
    async checkMyPartition(name) {
        if (!name) name = '此处存放因抽奖临时关注的up';
        const
            responseText = await get({
                url: API.RELATION_TAGS
            });
        if (/^\[(?:响应错误|请求失败)\]/.test(responseText)) {
            log.error('获取分区id', `访问出错 ${responseText}`);
            return undefined;
        }
        const res = strToJson(responseText);
        let tagid = undefined;
        if (res.code === 0) {
            const data = res.data.filter((it) => it.name === name);
            if (data.length) {
                log.info('获取分区id', `成功 ${name}`);
                tagid = data[0].tagid;
            } else {
                log.warn('获取分区id', `失败 无指定分区名${name}`);
            }
            if (name === '此处存放因抽奖临时关注的up') {
                if (typeof tagid === 'undefined') {
                    return bili_client.createPartition(name);
                } else {
                    return tagid;
                }
            } else {
                return tagid;
            }
        } else {
            log.error('获取分区id', `访问出错 可在my_config里手动填入\n${responseText}`);
            return tagid;
        }
    },
    /** 只读列出当前账号的关注分组，清理任务不得自动创建分组。 */
    async listMyPartitions() {
        const responseText = await get({ url: API.RELATION_TAGS });
        if (/^\[(?:响应错误|请求失败)\]/.test(responseText)) {
            log.error('读取关注分组', `访问失败 ${responseText}`);
            return null;
        }
        const res = strToJson(responseText);
        if (res.code !== 0 || !(res.data instanceof Array)) {
            log.error('读取关注分组', `接口返回异常(code=${res.code ?? 'unknown'})`);
            return null;
        }
        return res.data.map(item => ({ tagid: Number(item.tagid), name: String(item.name || '').trim(), count: Math.max(0, Number(item.count) || 0) }))
            .filter(item => Number.isFinite(item.tagid) && item.name);
    },
    /**
     * 创造分区
     * @param {string} partition_name
     * @returns {Promise<number>}
     */
    async createPartition(partition_name) {
        const
            responseText = await post({
                url: API.RELATION_TAG_CREATE,
                contents: {
                    tag: partition_name,
                    csrf: GlobalVar.get('csrf')
                }
            }),
            obj = strToJson(responseText);
        if (obj.code === 0) {
            /* 获取tagid */
            let { tagid } = obj.data;
            log.info('新建分区', '分区新建成功');
            return tagid;
        } else {
            log.error('新建分区', `分区新建失败\n${responseText}`);
            return undefined;
        }
    },
    /**
     * 获取一个分区中50个的id
     * @param {number} tagid
     * @param {number} n 1->
     * @returns {Promise<number[] | null>}
     */
    async getPartitionUID(tagid, n) {
        const
            responseText = await get({
                url: API.RELATION_TAG,
                query: {
                    mid: GlobalVar.get('myUID'),
                    tagid: tagid,
                    pn: n,
                    ps: 50
                }
            }),
            res = strToJson(responseText);
        let uids = [];
        if (res.code === 0) {
            res.data.forEach(d => {
                uids.push(d.mid);
            });
            log.info(`获取分组id${tagid}`, `成功获取取关分区列表${n}`);
            return uids;
        } else {
            log.error(`获取分组id${tagid}`, `获取取关分区列表失败\n${responseText}`);
            return null;
        }
    }
};

Object.defineProperty(bili_client, '__testDetailedResult', { value: detailedResult, enumerable: false });
Object.defineProperty(bili_client, '__testReserveLotteryDetailedResult', { value: reserveLotteryDetailedResult, enumerable: false });
module.exports = bili_client;
