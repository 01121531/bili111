const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cacheFile, readFollowingCache, writeFollowingCache, CACHE_TTL_MS } = require('../../lib/helper/following_cache');
const { fetchAllFollowings, loadFollowingList, hasFollowing, PAGE_SIZE } = require('../../lib/net/followings');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-followings-'));
}

test('关注列表分页合并并使用精确 UID 匹配', async () => {
    const calls = [];
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => ({ mid: index + 1 }));
    const items = await fetchAllFollowings('100', async page => {
        calls.push(page);
        return page === 1
            ? { code: 0, data: { total: 52, list: firstPage } }
            : { code: 0, data: { total: 52, list: [{ mid: 51 }, { mid: 52 }] } };
    });

    assert.deepEqual(calls, [1, 2]);
    assert.equal(items.size, 52);
    assert.equal(hasFollowing(items, '52'), true);
    assert.equal(hasFollowing(new Set(['12345']), '234'), false);
});

test('关注缓存按账号隔离并原子更新', () => {
    const baseDir = tempDir();
    try {
        writeFollowingCache({ accountId: 1, uid: '101', items: new Set(['1', '2']), baseDir });
        writeFollowingCache({ accountId: 2, uid: '202', items: new Set(['9']), baseDir });
        writeFollowingCache({ accountId: 1, uid: '101', items: new Set(['3']), baseDir });

        assert.deepEqual(readFollowingCache({ accountId: 1, uid: '101', baseDir }).items, ['3']);
        assert.deepEqual(readFollowingCache({ accountId: 2, uid: '202', baseDir }).items, ['9']);
        assert.equal(fs.readdirSync(baseDir).some(name => name.endsWith('.tmp')), false);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
});

test('在线失败时使用 24 小时内的有效缓存', async () => {
    const baseDir = tempDir();
    const now = Date.now();
    try {
        writeFollowingCache({ accountId: 7, uid: '700', items: new Set(['11', '22']), baseDir, now: now - 60_000 });
        const result = await loadFollowingList({
            accountId: 7,
            uid: '700',
            cacheDir: baseDir,
            now,
            fetchPage: async () => { throw new Error('network down'); }
        });

        assert.equal(result.source, 'cache');
        assert.deepEqual([...result.items], ['11', '22']);
    } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
    }
});

test('过期、错误 UID 和损坏缓存均被拒绝', async t => {
    await t.test('过期缓存', async () => {
        const baseDir = tempDir();
        const now = Date.now();
        try {
            writeFollowingCache({ accountId: 3, uid: '300', items: new Set(['1']), baseDir, now: now - CACHE_TTL_MS - 1 });
            await assert.rejects(loadFollowingList({ accountId: 3, uid: '300', cacheDir: baseDir, now, fetchPage: async () => { throw new Error('offline'); } }), /无有效缓存/);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    await t.test('缓存 UID 不匹配', async () => {
        const baseDir = tempDir();
        try {
            writeFollowingCache({ accountId: 4, uid: '400', items: new Set(['1']), baseDir });
            await assert.rejects(loadFollowingList({ accountId: 4, uid: '401', cacheDir: baseDir, fetchPage: async () => { throw new Error('offline'); } }), /无有效缓存/);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    await t.test('损坏缓存', async () => {
        const baseDir = tempDir();
        try {
            fs.mkdirSync(baseDir, { recursive: true });
            fs.writeFileSync(cacheFile(5, baseDir), '{broken', 'utf8');
            await assert.rejects(loadFollowingList({ accountId: 5, uid: '500', cacheDir: baseDir, fetchPage: async () => { throw new Error('offline'); } }), /无有效缓存/);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });
});
