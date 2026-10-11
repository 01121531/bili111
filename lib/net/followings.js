const { readFollowingCache, writeFollowingCache } = require('../helper/following_cache');

const PAGE_SIZE = 50;

async function fetchAllFollowings(uid, fetchPage) {
    const items = new Set();
    let page = 1;
    let total = Infinity;

    while (items.size < total) {
        const response = await fetchPage(page, PAGE_SIZE);
        if (!response || response.code !== 0 || !response.data || !Array.isArray(response.data.list)) {
            const code = response && Object.prototype.hasOwnProperty.call(response, 'code') ? response.code : 'invalid-response';
            throw new Error(`B站关注接口返回异常(code=${code})`);
        }
        const list = response.data.list;
        total = Number(response.data.total);
        if (!Number.isFinite(total) || total < 0) total = items.size + list.length;
        for (const item of list) {
            if (item && /^\d+$/.test(String(item.mid))) items.add(String(item.mid));
        }
        if (list.length === 0 || list.length < PAGE_SIZE || items.size >= total) break;
        page += 1;
    }
    return items;
}

async function loadFollowingList({ uid, accountId, fetchPage, cacheDir, now = Date.now() }) {
    try {
        const items = await fetchAllFollowings(uid, fetchPage);
        let cacheError = null;
        try {
            writeFollowingCache({ accountId, uid, items, baseDir: cacheDir, now });
        } catch (error) {
            cacheError = error;
        }
        return { items, source: 'live', ageMs: 0, cacheError };
    } catch (liveError) {
        const cached = readFollowingCache({ accountId, uid, baseDir: cacheDir, now });
        if (cached) {
            return { items: new Set(cached.items), source: 'cache', ageMs: cached.ageMs, liveError };
        }
        throw new Error(`在线获取失败且无有效缓存: ${liveError.message}`);
    }
}

function hasFollowing(items, uid) {
    return !uid || items.has(String(uid));
}

module.exports = { PAGE_SIZE, fetchAllFollowings, loadFollowingList, hasFollowing };
