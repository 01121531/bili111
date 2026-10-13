const { log, delay, retryfn } = require('./utils');
const bili = require('./net/bili');
const { Searcher } = require('./core/searcher');
const global_var = require('./data/global_var');
const config = require('./data/config');
const { emitRuntimeEvent } = require('./helper/runtime_event');
const { buildCleanupPlan, idSet } = require('./helper/cleanup');

const MAX_SCAN_PAGES = 100;

function emitRecord(record) {
    emitRuntimeEvent('cleanup_record', { cleanup: record });
}

function emitSummary(summary) {
    emitRuntimeEvent('cleanup_summary', { cleanup: summary });
}

async function getFollowList(partitions) {
    const uids = new Set();
    const names = String(partitions || '').split(/[,，]+/).map(item => item.trim()).filter(Boolean);
    if (!names.length) return { ok: false, uids, reason: '未配置抽奖关注分组，本轮不执行取关' };

    for (const name of names) {
        const tagid = await bili.checkMyPartition(name);
        if (typeof tagid === 'undefined') return { ok: false, uids: new Set(), reason: `无法读取关注分组：${name}` };
        for (let page = 1; page <= MAX_SCAN_PAGES; page++) {
            const pageUids = await bili.getPartitionUID(tagid, page);
            if (pageUids === null) return { ok: false, uids: new Set(), reason: `关注分组读取失败：${name}` };
            pageUids.forEach(uid => uids.add(String(uid)));
            if (pageUids.length < 50) break;
            await delay(config.get_partition_wait);
        }
    }
    return { ok: true, uids, reason: '' };
}

async function scanAllDynamics(myUid, searchWait) {
    const items = [];
    const seenOffsets = new Set();
    let nextOffset = '0';
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
        log.info('开奖清理', `扫描账号转发动态，第 ${page + 1} 页`);
        const result = await retryfn(3, [null], () => Searcher.checkAllDynamic(myUid, 1, searchWait, nextOffset));
        if (!result) throw new Error(`第 ${page + 1} 页动态扫描失败，未执行任何清理操作`);
        items.push(...(result.allModifyDynamicResArray || []));
        const offset = String(result.offset || '0');
        if (result.hasMore === false || !offset || offset === '0') break;
        if (offset === nextOffset || seenOffsets.has(offset)) throw new Error('动态分页游标重复，未执行任何清理操作');
        seenOffsets.add(offset);
        nextOffset = offset;
        if (page === MAX_SCAN_PAGES - 1) throw new Error(`动态超过 ${MAX_SCAN_PAGES} 页，未完成全量扫描，本轮不执行清理`);
    }
    return items;
}

async function legacyQuickUnfollow(uidList, options) {
    log.warn('开奖清理', 'CLI 兼容模式：执行旧版快速取关规则');
    let failed = 0;
    for (const uid of uidList) {
        const fans = await bili.getUserInfo(Number(uid));
        if (fans !== -1 && fans < options.fansLimit) {
            const ok = await retryfn(3, [false], () => bili.cancelAttention(Number(uid)));
            emitRecord({ action: 'unfollow', targetId: uid, status: ok ? 'success' : 'failed', reason: ok ? '旧版快速取关完成' : '旧版快速取关失败' });
            if (!ok) failed += 1;
            await delay(options.delayMs);
        }
    }
    if (failed) throw new Error(`快速取关失败 ${failed} 项`);
}

async function clear(options = {}) {
    const preview = options.preview === true || process.env.CLEAR_PREVIEW === '1';
    const webManaged = process.env.WEB_MANAGED_CLEAR === '1';
    const myUid = String(global_var.get('myUID'));
    const maxDays = Math.max(1, Math.min(3650, Math.round(Number(config.clear_max_day) || 30)));
    const whitelist = idSet(config.clear_white_list);
    let storedProtected = [];
    try { storedProtected = JSON.parse(process.env.CLEANUP_ACTIVE_UP_UIDS || '[]'); } catch { storedProtected = []; }
    const extraProtectedUids = idSet(storedProtected);
    const unresolvedActive = process.env.CLEANUP_UNRESOLVED_ACTIVE === '1';

    const dynamics = await scanAllDynamics(Number(myUid), config.search_wait);
    const followList = config.clear_remove_attention
        ? await getFollowList(config.clear_partition)
        : { ok: false, uids: new Set(), reason: '已关闭自动取关' };
    if (!followList.ok) log.warn('开奖清理', followList.reason);

    if (config.clear_quick_remove_attention && !webManaged && !preview) {
        await legacyQuickUnfollow(followList.uids, {
            fansLimit: config.clear_quick_remove_attention_fans_number_smallest,
            delayMs: config.clear_remove_delay,
        });
        return;
    }

    const plan = buildCleanupPlan(dynamics, {
        now: Date.now() / 1000,
        maxDays,
        dynamicTypes: webManaged ? [1] : config.clear_dynamic_type,
        whitelist,
        partitionUids: followList.ok ? followList.uids : [],
        protectedUids: extraProtectedUids,
        unresolvedActive,
        myUid,
    });

    if (unresolvedActive) log.warn('开奖清理', '存在无法确认 UP 主 UID 的进行中参与记录，本轮不执行取关');
    for (const item of plan.invalid) emitRecord({
        action: 'skip',
        targetId: item.dynamicId || item.originUid || 'unknown',
        relatedUid: item.originUid || null,
        dynamicCreatedAt: item.createdAt || null,
        inferredExpiredAt: item.createdAt ? item.createdAt + maxDays * 86400 : null,
        status: 'skipped',
        reason: item.reason,
    });

    const summary = {
        preview,
        thresholdDays: maxDays,
        scannedCount: dynamics.length,
        relevantCount: plan.relevant.length,
        activeCount: plan.active.length,
        expiredCount: plan.expired.length,
        protectedUpCount: plan.protectedUids.length,
        deleteCandidateCount: config.clear_remove_dynamic ? plan.deleteCandidates.length : 0,
        deleteSuccessCount: 0,
        deleteFailedCount: 0,
        unfollowCandidateCount: config.clear_remove_attention && followList.ok ? plan.unfollowCandidates.length : 0,
        unfollowSuccessCount: 0,
        unfollowFailedCount: 0,
        unfollowBlockedReason: unresolvedActive ? '存在无法确认 UP 主 UID 的进行中参与记录' : followList.reason || '',
    };

    if (preview) {
        for (const item of plan.deleteCandidates) if (config.clear_remove_dynamic) emitRecord({ action: 'dynamic_delete', targetId: item.dynamicId, relatedUid: item.originUid || null, dynamicCreatedAt: item.createdAt, inferredExpiredAt: item.createdAt + maxDays * 86400, status: 'candidate', reason: `发布已满 ${maxDays} 天` });
        for (const uid of plan.unfollowCandidates) if (config.clear_remove_attention && followList.ok) emitRecord({ action: 'unfollow', targetId: uid, status: 'candidate', reason: '抽奖关注分组中已无进行中的参与动态' });
        emitSummary(summary);
        log.info('开奖清理', `预览完成：扫描 ${summary.scannedCount} 条，过期 ${summary.expiredCount} 条，预计删除 ${summary.deleteCandidateCount} 条，预计取关 ${summary.unfollowCandidateCount} 人`);
        return;
    }

    let failures = 0;
    if (config.clear_remove_dynamic) for (const item of plan.deleteCandidates) {
        const ok = await retryfn(3, [false], () => bili.rmDynamic(item.dynamicId));
        if (ok) summary.deleteSuccessCount += 1;
        else { summary.deleteFailedCount += 1; failures += 1; }
        emitRecord({ action: 'dynamic_delete', targetId: item.dynamicId, relatedUid: item.originUid || null, dynamicCreatedAt: item.createdAt, inferredExpiredAt: item.createdAt + maxDays * 86400, status: ok ? 'success' : 'failed', reason: ok ? '过期转发动态已删除' : '删除动态失败' });
        await delay(config.clear_remove_delay);
    }

    if (config.clear_remove_attention && followList.ok) for (const uid of plan.unfollowCandidates) {
        const ok = await retryfn(3, [false], () => bili.cancelAttention(Number(uid)));
        if (ok) summary.unfollowSuccessCount += 1;
        else { summary.unfollowFailedCount += 1; failures += 1; }
        emitRecord({ action: 'unfollow', targetId: uid, status: ok ? 'success' : 'failed', reason: ok ? '已无进行中抽奖，取消关注成功' : '取消关注失败' });
        await delay(config.clear_remove_delay);
    }

    emitSummary(summary);
    log.info('开奖清理', `完成：扫描 ${summary.scannedCount} 条，删除 ${summary.deleteSuccessCount}/${summary.deleteCandidateCount} 条，取关 ${summary.unfollowSuccessCount}/${summary.unfollowCandidateCount} 人`);
    if (failures) throw new Error(`开奖清理有 ${failures} 项操作失败，请查看清理明细`);
}

module.exports = { clear, scanAllDynamics, getFollowList };
