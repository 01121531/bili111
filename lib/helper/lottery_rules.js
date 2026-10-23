function normalizeBlockedUids(values) {
    const normalized = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const uid = Number(value);
        if (!Number.isSafeInteger(uid) || uid <= 0 || seen.has(uid)) continue;
        seen.add(uid);
        normalized.push(uid);
    }
    return normalized;
}

function findBlockedLotteryUid(realUid, blockedUids) {
    if (realUid === null || realUid === undefined || String(realUid).trim() === '') return null;
    const uid = Number(realUid);
    if (!Number.isSafeInteger(uid) || uid <= 0) return null;
    return normalizeBlockedUids(blockedUids).includes(uid) ? uid : null;
}

module.exports = { findBlockedLotteryUid, normalizeBlockedUids };
