const bili = require('../net/bili');
const config = require('../data/config');
const globalVar = require('../data/global_var');
const { getAiContent, getRandomOne, log, shuffle } = require('../utils');

function safeCommentText(value, fallback = '') {
    const normalize = text => String(text || '')
        .replace(/```[\s\S]*?```/g, '')
        .trim()
        .slice(0, 500);
    let sensitiveWords = [];
    try {
        sensitiveWords = JSON.parse(process.env.AI_SENSITIVE_WORDS || '[]');
    } catch (_) {
        // Ignore malformed runtime settings and use the configured fallback.
    }
    const text = normalize(value);
    if (text && !sensitiveWords.some(word => word && text.includes(word))) return text;
    const backup = normalize(fallback);
    return backup && !sensitiveWords.some(word => word && backup.includes(word)) ? backup : '';
}

function renderPrompt(template, variables) {
    return String(template || '').replace(/\{(dynamic_text|author|lottery_conditions|draw_time|account_name)\}/g, (_, key) => variables[key] || '');
}

function commentMatchesBlockword(message, word) {
    const text = String(message || '').normalize('NFKC');
    const value = String(word || '').trim();
    if (!value) return false;
    if (text.toLowerCase().includes(value.normalize('NFKC').toLowerCase())) return true;
    try {
        return new RegExp(value, 'iu').test(text);
    } catch (_) {
        return false;
    }
}

function filterCopiedComments(comments, blockwords = [], upUname = '') {
    const seen = new Set();
    const normalizedUpUname = String(upUname || '').normalize('NFKC').trim();
    return (Array.isArray(comments) ? comments : [])
        .map(comment => {
            if (!Array.isArray(comment) || comment.length < 2) return null;
            const uname = String(comment[0] || '').trim();
            const message = String(comment[1] || '').trim();
            if (!message || !uname) return null;
            if (normalizedUpUname && uname.normalize('NFKC').trim() === normalizedUpUname) return null;
            if (blockwords.some(word => commentMatchesBlockword(message, word))) return null;
            if (seen.has(message)) return null;
            seen.add(message);
            return [uname, message];
        })
        .filter(Boolean);
}

function renderCopiedComment(comment, myUname = '') {
    if (!Array.isArray(comment) || comment.length < 2) return '';
    const [author, message] = comment;
    const escaped = String(author || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const replaced = escaped
        ? String(message || '').replace(new RegExp(escaped, 'g'), myUname)
        : String(message || '');
    return safeCommentText(replaced, '');
}

async function fetchCopiedComment(rid, type, options = {}) {
    if (!rid || !type) return null;
    const runtimeConfig = options.config || config;
    const client = options.biliClient || bili;
    const myUname = options.myUname ?? (globalVar.get('myUNAME') || '');
    let comments = [];
    try {
        if (typeof client.getChatDetailed === 'function') {
            const result = await client.getChatDetailed(rid, type);
            if (result.status !== 'success') {
                const detail = result.providerCode !== null && result.providerCode !== undefined
                    ? `B站返回 ${result.providerCode}${result.providerMessage ? `（${result.providerMessage}）` : ''}`
                    : result.reason || '响应格式异常';
                log.warn('复制评论', `读取评论区失败：${detail}`);
                return null;
            }
            comments = result.comments || [];
        } else {
            comments = await client.getChat(rid, type);
        }
    } catch (error) {
        const message = String(error instanceof Error ? error.message : error || '')
            .replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••')
            .slice(0, 300);
        log.warn('复制评论', `读取评论区失败${message ? `：${message}` : ''}`);
        return null;
    }
    const available = filterCopiedComments(comments, runtimeConfig.copy_blockword || [], options.upUname || '');
    for (const comment of shuffle(available)) {
        const text = renderCopiedComment(comment, myUname);
        if (text) return { text, source: 'copied' };
    }
    return null;
}

function configuredComment(target = {}, runtimeConfig = config) {
    return safeCommentText((getRandomOne(runtimeConfig.chat || []) || '!!!').replace(/\$\{uname\}/g, target.uname || ''));
}

async function buildComment(target = {}, options = {}) {
    const runtimeConfig = options.config || config;
    const getAi = options.getAiContent || getAiContent;
    const copyComment = options.fetchCopiedComment || fetchCopiedComment;
    const canUseAi = typeof options.canUseAi === 'function' ? options.canUseAi : () => true;
    const fixed = () => configuredComment(target, runtimeConfig);
    let copyAttempted = false;
    const copied = async () => {
        if (copyAttempted) return null;
        copyAttempted = true;
        if (runtimeConfig.copy_chat_on_ai_failure === false && !runtimeConfig.is_copy_chat) return null;
        return copyComment(target.rid || target.rid_str, target.chat_type, {
            config: runtimeConfig,
            biliClient: options.biliClient,
            myUname: options.myUname,
            upUname: target.uname || ''
        });
    };

    if (runtimeConfig.is_copy_chat) {
        const copy = await copied();
        if (copy) return { ...copy, aiFailed: false };
        const fallback = safeCommentText(process.env.AI_FALLBACK_COMMENT, '');
        return { text: fallback || fixed(), source: fallback ? 'fallback' : 'configured', aiFailed: false };
    }

    const aiEnabled = Boolean(process.env.ENABLE_AI_COMMENTS && runtimeConfig.ai_comments_parm);
    if (aiEnabled && canUseAi()) {
        try {
            const generated = await getAi(
                runtimeConfig.ai_comments_parm.url,
                runtimeConfig.ai_comments_parm.body,
                renderPrompt(runtimeConfig.ai_comments_parm.prompt, {
                    dynamic_text: target.description,
                    author: target.uname,
                    lottery_conditions: target.lottery_conditions || target.description,
                    draw_time: target.draw_time || '',
                    account_name: process.env.NOTE || ''
                }),
                target.description
            );
            const ai = safeCommentText(generated, '');
            if (ai) return { text: ai, source: 'ai', aiFailed: false };
        } catch (_) {
            log.warn('复制评论', 'AI 评论请求失败，将尝试复制评论区内容');
        }
    } else if (aiEnabled) {
        log.warn('复制评论', '本次任务已达到 AI 请求上限，将尝试复制评论区内容');
    }

    const copy = await copied();
    if (copy) return { ...copy, aiFailed: true };
    const fallback = safeCommentText(process.env.AI_FALLBACK_COMMENT, '');
    return { text: fallback || fixed(), source: fallback ? 'fallback' : 'configured', aiFailed: true };
}

module.exports = {
    buildComment,
    configuredComment,
    fetchCopiedComment,
    filterCopiedComments,
    renderCopiedComment,
    safeCommentText
};
