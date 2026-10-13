const { log, getAiContent, getRandomOne } = require('./utils');
const bili = require('./net/bili');
const config = require('./data/config');
const { Monitor } = require('./core/monitor');
const { parseDynamicCard } = require('./core/searcher');
const { emitRuntimeEvent } = require('./helper/runtime_event');

function safeText(value, fallback = '') {
    const text = String(value || '').replace(/```[\s\S]*?```/g, '').trim().slice(0, 500);
    let sensitive = [];
    try { sensitive = JSON.parse(process.env.AI_SENSITIVE_WORDS || '[]'); } catch (_) { /* ignore malformed settings */ }
    if (text && !sensitive.some(word => word && text.includes(word))) return text;
    const backup = String(fallback || '').replace(/```[\s\S]*?```/g, '').trim().slice(0, 500);
    return backup && !sensitive.some(word => word && backup.includes(word)) ? backup : '';
}

function renderPrompt(template, variables) {
    return String(template || '').replace(/\{(dynamic_text|author|lottery_conditions|draw_time|account_name)\}/g, (_, key) => variables[key] || '');
}

async function buildComment(target) {
    const fixed = () => safeText((getRandomOne(config.chat || []) || '!!!').replace(/\$\{uname\}/g, target.uname || ''));
    if (process.env.ENABLE_AI_COMMENTS && config.ai_comments_parm) {
        try {
            const generated = await getAiContent(
                config.ai_comments_parm.url,
                config.ai_comments_parm.body,
                renderPrompt(config.ai_comments_parm.prompt, {
                    dynamic_text: target.description,
                    author: target.uname,
                    lottery_conditions: target.description,
                    draw_time: '',
                    account_name: process.env.NOTE || ''
                }),
                target.description
            );
            const ai = safeText(generated, '');
            if (ai) return { text: ai, source: 'ai' };
            const fallback = safeText(process.env.AI_FALLBACK_COMMENT, '');
            return { text: fallback || fixed(), source: fallback ? 'fallback' : 'configured' };
        } catch (error) {
            log.warn('补充评论', `AI 评论失败，使用备用文案：${error instanceof Error ? error.message : String(error)}`);
            const fallback = safeText(process.env.AI_FALLBACK_COMMENT, '');
            return { text: fallback || fixed(), source: fallback ? 'fallback' : 'configured' };
        }
    }
    return { text: fixed(), source: 'configured' };
}

async function runCommentBackfill() {
    let items = [];
    try { items = JSON.parse(process.env.COMMENT_BACKFILL_ITEMS || '[]'); } catch (_) { items = []; }
    const monitor = new Monitor([], {});
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    for (const item of items) {
        const dyid = String(item.dyid || '');
        if (!dyid) continue;
        attempted += 1;
        let participation;
        try {
            const card = await bili.getOneDynamicByDyid(dyid);
            if (!card) throw new Error('动态不存在或无法访问');
            const parsed = parseDynamicCard(card);
            const target = parsed?.type === 1 && parsed.origin?.dynamic_id ? parsed.origin : parsed;
            if (!target?.rid_str || !target?.chat_type) throw new Error('无法获取评论区标识');
            const comment = await buildComment(target);
            if (!comment.text) throw new Error('没有可提交的评论文案');
            participation = await monitor.go({
                dyid,
                rid: target.rid_str,
                chat_type: target.chat_type,
                chat: comment.text,
                comment_source: comment.source,
                uid: [],
                relay_chat: '',
                ctrl: [],
                commentOnly: true
            });
        } catch (error) {
            participation = {
                code: 1001,
                overallStatus: 'failed',
                reason: error instanceof Error ? error.message : String(error),
                comment: { plannedText: null, actualText: null, source: 'none', status: 'failed', code: 1001, reason: error instanceof Error ? error.message : String(error) },
                follow: { status: 'not_required', code: 0, reason: '补充评论任务不执行关注' },
                like: { status: 'not_required', code: 0, reason: '补充评论任务不执行点赞' },
                relay: { status: 'not_required', code: 0, reason: '补充评论任务不执行转发' },
                startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
            };
        }
        emitRuntimeEvent('lottery_participation', { participation: { dyid, ...participation } });
        if (participation.overallStatus === 'success') succeeded += 1;
        else failed += 1;
        log.info('补充评论', `${dyid}：${participation.reason || '已完成'}`);
    }
    if (!attempted) log.info('补充评论', '没有待补充评论的动态');
    else log.info('补充评论', `本批尝试 ${attempted} 条，成功 ${succeeded} 条，失败 ${failed} 条`);
    if (failed) throw new Error(`补充历史评论失败 ${failed} 条`);
}

module.exports = { runCommentBackfill };
