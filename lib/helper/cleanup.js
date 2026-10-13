function idSet(value) {
    const items = value instanceof Set
        ? [...value]
        : Array.isArray(value)
            ? value
            : String(value || '').split(/[,，\s]+/);
    return new Set(items.map(item => String(item).trim()).filter(Boolean));
}

function cleanupTypes(value) {
    const items = Array.isArray(value) ? value : [value];
    const types = new Set(items.map(Number).filter(Number.isFinite));
    return types.size ? types : new Set([1]);
}

function buildCleanupPlan(dynamics, options = {}) {
    const now = Number(options.now) || Date.now() / 1000;
    const maxDays = Math.max(1, Math.min(3650, Math.round(Number(options.maxDays) || 30)));
    const cutoff = now - maxDays * 86400;
    const types = cleanupTypes(options.dynamicTypes);
    const whitelist = idSet(options.whitelist);
    const partitionUids = idSet(options.partitionUids);
    const protectedUids = idSet(options.protectedUids);
    const myUid = String(options.myUid || '');
    const relevant = [];
    const active = [];
    const expired = [];
    const invalid = [];
    const deleteCandidates = [];
    const candidateUpUids = new Set();

    for (const raw of Array.isArray(dynamics) ? dynamics : []) {
        const item = raw || {};
        const type = Number(item.type);
        if (!types.has(type)) continue;
        const dynamicId = String(item.dynamic_id || '').trim();
        const originUid = String(item.origin_uid || '').trim();
        const createdAt = Number(item.create_time);
        const normalized = { ...item, dynamicId, originUid, createdAt };
        relevant.push(normalized);
        if (!Number.isFinite(createdAt) || createdAt <= 0) {
            invalid.push({ ...normalized, reason: '动态发布时间无效，已跳过' });
            continue;
        }
        if (createdAt > cutoff) {
            active.push(normalized);
            if (originUid) protectedUids.add(originUid);
            continue;
        }
        expired.push(normalized);
        if (originUid) candidateUpUids.add(originUid);
        if (!dynamicId) invalid.push({ ...normalized, reason: '动态 ID 为空，无法删除' });
        else if (whitelist.has(dynamicId)) invalid.push({ ...normalized, reason: '动态位于清理白名单' });
        else deleteCandidates.push(normalized);
    }

    const unfollowBlocked = Boolean(options.unresolvedActive);
    const unfollowCandidates = unfollowBlocked ? [] : [...candidateUpUids]
        .filter(uid => uid && uid !== myUid && partitionUids.has(uid) && !protectedUids.has(uid) && !whitelist.has(uid));

    return {
        now,
        maxDays,
        cutoff,
        relevant,
        active,
        expired,
        invalid,
        deleteCandidates,
        protectedUids: [...protectedUids],
        unfollowCandidates,
        unfollowBlocked,
    };
}

module.exports = { buildCleanupPlan, idSet };
