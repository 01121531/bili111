const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheFile(accountId, baseDir = path.join(process.cwd(), 'data', 'followings')) {
    const id = String(accountId || '');
    if (!/^\d+$/.test(id)) throw new Error('无效的账号缓存标识');
    return path.join(baseDir, `account-${id}.json`);
}

function readFollowingCache({ accountId, uid, baseDir, now = Date.now(), ttlMs = CACHE_TTL_MS }) {
    try {
        const file = cacheFile(accountId, baseDir);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const fetchedAt = Date.parse(data.fetchedAt);
        if (String(data.uid) !== String(uid)
            || !Number.isFinite(fetchedAt)
            || now - fetchedAt < 0
            || now - fetchedAt > ttlMs
            || !Array.isArray(data.items)
            || data.items.some(item => !/^\d+$/.test(String(item)))) {
            return null;
        }
        return {
            uid: String(data.uid),
            fetchedAt: data.fetchedAt,
            ageMs: now - fetchedAt,
            items: [...new Set(data.items.map(String))]
        };
    } catch (_) {
        return null;
    }
}

function writeFollowingCache({ accountId, uid, items, baseDir, now = Date.now() }) {
    const file = cacheFile(accountId, baseDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    const data = {
        uid: String(uid),
        fetchedAt: new Date(now).toISOString(),
        items: [...new Set([...items].map(String))]
    };
    try {
        fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tempFile, file);
    } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
    return data;
}

module.exports = { CACHE_TTL_MS, cacheFile, readFollowingCache, writeFollowingCache };
