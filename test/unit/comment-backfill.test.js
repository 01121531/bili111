const test = require('node:test');
const assert = require('node:assert/strict');
const { runCommentBackfill, accountCannotComment } = require('../../lib/comment-backfill');

test('补充评论遇到账号未转正后停止本批剩余请求', async () => {
    const previous = process.env.COMMENT_BACKFILL_ITEMS;
    process.env.COMMENT_BACKFILL_ITEMS = JSON.stringify([{ dyid: '9001' }, { dyid: '9002' }, { dyid: '9003' }]);
    const fetched = [];
    const commented = [];
    const events = [];
    const monitor = {
        go: async option => {
            commented.push(option.dyid);
            return {
                overallStatus: 'failed',
                reason: '评论失败：B站返回 -107（账号未转正）',
                comment: {
                    status: 'failed',
                    providerCode: -107,
                    providerMessage: '账号未转正',
                    reason: '评论失败：B站返回 -107（账号未转正）'
                }
            };
        }
    };
    try {
        await assert.rejects(
            () => runCommentBackfill({
                createMonitor: () => monitor,
                getDynamic: async dyid => { fetched.push(dyid); return { dyid }; },
                parseCard: card => ({ rid_str: `rid-${card.dyid}`, chat_type: 1 }),
                buildComment: async () => ({ text: '测试评论', source: 'configured' }),
                emitRuntimeEvent: (name, payload) => events.push({ name, payload })
            }),
            /补充历史评论失败 1 条/
        );
        assert.deepEqual(fetched, ['9001']);
        assert.deepEqual(commented, ['9001']);
        assert.equal(events.length, 1);
    } finally {
        if (previous === undefined) delete process.env.COMMENT_BACKFILL_ITEMS;
        else process.env.COMMENT_BACKFILL_ITEMS = previous;
    }
});

test('只有账号未转正才触发补充评论批次熔断', () => {
    assert.equal(accountCannotComment({ comment: { providerCode: -107 } }), true);
    assert.equal(accountCannotComment({ comment: { providerMessage: '账号未转正' } }), true);
    assert.equal(accountCannotComment({ comment: { providerCode: 12061, providerMessage: 'UP主已关闭评论区' } }), false);
});
