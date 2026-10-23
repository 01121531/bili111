const { log } = require('./utils');
const bili = require('./net/bili');
const { Monitor } = require('./core/monitor');
const { parseDynamicCard } = require('./core/searcher');
const { emitRuntimeEvent } = require('./helper/runtime_event');
const { buildComment } = require('./helper/comment_fallback');

function accountCannotComment(participation) {
    const comment = participation?.comment || {};
    const message = [comment.providerCode, comment.providerMessage, comment.reason, participation?.reason]
        .filter(value => value !== undefined && value !== null)
        .join(' ');
    return Number(comment.providerCode) === -107 || /账号未转正/.test(message);
}

async function runCommentBackfill(dependencies = {}) {
    let items = [];
    try { items = JSON.parse(process.env.COMMENT_BACKFILL_ITEMS || '[]'); } catch (_) { items = []; }
    const createMonitor = dependencies.createMonitor || (() => new Monitor([], {}));
    const getDynamic = dependencies.getDynamic || bili.getOneDynamicByDyid.bind(bili);
    const parseCard = dependencies.parseCard || parseDynamicCard;
    const commentBuilder = dependencies.buildComment || buildComment;
    const emitEvent = dependencies.emitRuntimeEvent || emitRuntimeEvent;
    const monitor = createMonitor();
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let stoppedByAccountState = false;
    for (const item of items) {
        const dyid = String(item.dyid || '');
        if (!dyid) continue;
        attempted += 1;
        let participation;
        try {
            const card = await getDynamic(dyid);
            if (!card) throw new Error('动态不存在或无法访问');
            const parsed = parseCard(card);
            const target = parsed?.type === 1 && parsed.origin?.dynamic_id ? parsed.origin : parsed;
            if (!target?.rid_str || !target?.chat_type) throw new Error('无法获取评论区标识');
            const comment = await commentBuilder(target);
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
        emitEvent('lottery_participation', { participation: { dyid, ...participation } });
        if (participation.overallStatus === 'success') succeeded += 1;
        else failed += 1;
        log.info('补充评论', `${dyid}：${participation.reason || '已完成'}`);
        if (accountCannotComment(participation)) {
            stoppedByAccountState = true;
            log.warn('补充评论', `账号未转正，已停止本批剩余评论；剩余 ${Math.max(0, items.length - attempted)} 条未发送请求`);
            break;
        }
    }
    if (!attempted) log.info('补充评论', '没有待补充评论的动态');
    else log.info('补充评论', `本批尝试 ${attempted} 条，成功 ${succeeded} 条，失败 ${failed} 条${stoppedByAccountState ? '，因账号未转正提前停止' : ''}`);
    if (failed) throw new Error(`补充历史评论失败 ${failed} 条`);
}

module.exports = { runCommentBackfill, accountCannotComment };
