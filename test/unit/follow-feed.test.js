const test = require('node:test');
const assert = require('node:assert/strict');
const bili = require('../../lib/net/bili');
const utils = require('../../lib/utils');
const dStorage = require('../../lib/helper/d_storage');
const config = require('../../my_config.example.js').default_config;
const { Searcher } = require('../../lib/core/searcher');
const { Monitor } = require('../../lib/core/monitor');

function directItem(id, uid, description) {
    return {
        id_str: String(id),
        type: 'DYNAMIC_TYPE_WORD',
        basic: { comment_id_str: `rid-${id}` },
        modules: {
            module_author: { mid: uid, name: `UP-${uid}`, pub_ts: 1700000000 },
            module_stat: { like: { status: false } },
            module_dynamic: {
                desc: { rich_text_nodes: [{ type: 'RICH_TEXT_NODE_TYPE_TEXT', text: description, orig_text: description }] }
            }
        }
    };
}

function forwardItem(id, uid, original) {
    const item = directItem(id, uid, '转发动态');
    item.type = 'DYNAMIC_TYPE_FORWARD';
    item.orig = original;
    return item;
}

test('关注动态流分页、保留末页、解包转发并按动态 ID 去重', async () => {
    const originalGetFollowFeed = bili.getFollowFeed;
    const originalDelay = utils.delay;
    const calls = [];
    bili.getFollowFeed = async offset => {
        calls.push(offset);
        if (!offset) return JSON.stringify({
            code: 0,
            data: {
                has_more: true,
                offset: 'page-2',
                items: [
                    directItem('100000001', 101, '抽奖 转发参与'),
                    forwardItem('900000001', 999, directItem('200000002', 202, '福利 关注参与'))
                ]
            }
        });
        return JSON.stringify({
            code: 0,
            data: {
                has_more: false,
                offset: 'page-3',
                items: [
                    directItem('100000001', 101, '重复动态'),
                    directItem('300000003', 303, '抽奖 评论参与')
                ]
            }
        });
    };
    utils.delay = async () => {};

    try {
        const result = await new Searcher().getLotteryInfoByFollowFeed(5);
        assert.deepEqual(calls, ['', 'page-2']);
        assert.deepEqual(result.map(item => item.dyid), ['100000001', '200000002', '300000003']);
        assert.equal(result[1].uname, 'UP-202');
        assert.deepEqual(result[1].uids, [202, 0]);
        assert.equal(result[1].type, 4);
    } finally {
        bili.getFollowFeed = originalGetFollowFeed;
        utils.delay = originalDelay;
    }
});

test('关注动态流接口异常会标记来源失败', async () => {
    const originalGetFollowFeed = bili.getFollowFeed;
    bili.getFollowFeed = async () => JSON.stringify({ code: -412, message: 'request blocked' });
    try {
        assert.equal(await new Searcher().getLotteryInfoByFollowFeed(1), null);
    } finally {
        bili.getFollowFeed = originalGetFollowFeed;
    }
});

test('演练模式不写入 dyid，真实模式仍正常写入', async () => {
    const originalUpdate = dStorage.updateDyid;
    let writes = 0;
    dStorage.updateDyid = async () => { writes += 1; };
    try {
        process.env.NOT_GO_LOTTERY = '1';
        await new Monitor(['FollowFeed', 1]).markProcessed('100');
        assert.equal(writes, 0);

        delete process.env.NOT_GO_LOTTERY;
        await new Monitor(['FollowFeed', 1]).markProcessed('100');
        assert.equal(writes, 1);
    } finally {
        delete process.env.NOT_GO_LOTTERY;
        dStorage.updateDyid = originalUpdate;
    }
});

test('默认配置优先扫描 5 页关注流且不再包含无效文件 API', () => {
    assert.deepEqual(config.FollowFeed, [5]);
    assert.deepEqual(config.ArticleUIDs, []);
    assert.deepEqual(config.APIs, []);
    assert.deepEqual(config.TxT, []);
    assert.equal(config.LotteryOrder[0], 5);
    assert.equal(config.LotteryOrder[1], 6);
});

test('合集账号来源按 UID 获取专栏并使用独立来源标记', async () => {
    const originalGetArticlesByUID = bili.getArticlesByUID;
    const searcher = new Searcher();
    let requested;
    let normalized;
    bili.getArticlesByUID = async (uid, limit) => {
        requested = { uid, limit };
        return [{ id: 53378913, pub_time: 1791656548 }];
    };
    searcher.getLotteryInfoFromArticles = async (articles, type) => {
        normalized = { articles, type };
        return [];
    };

    try {
        const result = await searcher.getLotteryInfoByArticleUID('100680137');
        assert.equal(requested.uid, '100680137');
        assert.ok(requested.limit > 0);
        assert.deepEqual(result, []);
        assert.deepEqual(normalized, {
            articles: [{ id: 53378913, pub_time: 1791656548 }],
            type: 'article_uid'
        });
        assert.equal(new Monitor(['ArticleUIDs', '100680137']).LotteryInfoMap.has('ArticleUIDs'), true);
    } finally {
        bili.getArticlesByUID = originalGetArticlesByUID;
    }
});

test('专栏正文请求失败不会静默记录为成功 0 条', async () => {
    const originalGetOneArticleByCv = bili.getOneArticleByCv;
    bili.getOneArticleByCv = async () => null;
    try {
        const result = await new Searcher().getLotteryInfoFromArticles([
            { id: 53378913, pub_time: Math.floor(Date.now() / 1000) }
        ], 'article_uid');
        assert.equal(result, null);
    } finally {
        bili.getOneArticleByCv = originalGetOneArticleByCv;
    }
});

test('新版专栏 opus 节点中的动态链接会被提取', () => {
    const links = bili.collectArticleDynamicLinks({
        content: {
            paragraphs: [
                { text: { nodes: [{ link: { link: 'https://www.bilibili.com/opus/1253856929797636100?from=article' } }] } },
                { text: { nodes: [{ link: { link: 'https://t.bilibili.com/1250780096826966017' } }] } },
                { text: { nodes: [{ link: { link: 'https://example.com/123456789012345678' } }] } }
            ]
        }
    });
    assert.deepEqual(links, [
        'https://www.bilibili.com/opus/1253856929797636100?from=article',
        'https://t.bilibili.com/1250780096826966017'
    ]);
});

test('动态详情风控码不会重复切换同一线路', () => {
    const [shouldSwitch, value, message] = bili._getOneDynamicByDyid.pub_handler(
        JSON.stringify({ code: -352, message: '-352' })
    );
    assert.equal(shouldSwitch, false);
    assert.equal(value, null);
    assert.match(message, /停止继续请求/);
});

test('专栏触发风控后停止当前专栏并跳过后续专栏来源', async () => {
    const originalGetOneArticleByCv = bili.getOneArticleByCv;
    const originalGetOneDynamicByDyid = bili.getOneDynamicByDyid;
    const searcher = new Searcher();
    searcher.taskContext = {};
    let articleCalls = 0;
    bili.getOneArticleByCv = async () => {
        articleCalls += 1;
        return 'https://www.bilibili.com/opus/1253856929797636100';
    };
    bili.getOneDynamicByDyid = async () => null;
    const article = [{ id: 53378913, pub_time: Math.floor(Date.now() / 1000) }];

    try {
        assert.deepEqual(await searcher.getLotteryInfoFromArticles(article, 'article_uid'), []);
        assert.equal(searcher.taskContext.dynamicRiskBlocked, true);
        assert.deepEqual(await searcher.getLotteryInfoFromArticles(article, 'article_uid'), []);
        assert.equal(articleCalls, 1);
    } finally {
        bili.getOneArticleByCv = originalGetOneArticleByCv;
        bili.getOneDynamicByDyid = originalGetOneDynamicByDyid;
    }
});
