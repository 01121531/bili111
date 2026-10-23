const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildComment,
    filterCopiedComments,
    renderCopiedComment
} = require('../../lib/helper/comment_fallback');

function withEnvironment(values, callback) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    return Promise.resolve()
        .then(callback)
        .finally(() => {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
}

test('AI 未启用时复制当前动态评论区并记录 copied 来源', async () => {
    await withEnvironment({ ENABLE_AI_COMMENTS: undefined }, async () => {
        let copyCalls = 0;
        let aiCalls = 0;
        const result = await buildComment({
            rid: 'rid-1',
            chat_type: 17,
            description: '抽奖动态',
            uname: 'UP主'
        }, {
            config: {
                is_copy_chat: false,
                copy_chat_on_ai_failure: true,
                chat: ['固定评论']
            },
            fetchCopiedComment: async () => {
                copyCalls += 1;
                return { text: '评论区文案', source: 'copied' };
            },
            getAiContent: async () => {
                aiCalls += 1;
                return '不应调用';
            }
        });

        assert.deepEqual(result, { text: '评论区文案', source: 'copied', aiFailed: true });
        assert.equal(copyCalls, 1);
        assert.equal(aiCalls, 0);
    });
});

test('AI 请求失败或返回空内容时复制评论区', async () => {
    await withEnvironment({ ENABLE_AI_COMMENTS: '1' }, async () => {
        for (const getAiContent of [
            async () => { throw new Error('AI 超时'); },
            async () => ''
        ]) {
            const result = await buildComment({
                rid: 'rid-1',
                chat_type: 17,
                description: '抽奖动态',
                uname: 'UP主'
            }, {
                config: {
                    is_copy_chat: false,
                    copy_chat_on_ai_failure: true,
                    ai_comments_parm: { url: 'http://example.test', body: {}, prompt: '{dynamic_text}' },
                    chat: ['固定评论']
                },
                getAiContent,
                fetchCopiedComment: async () => ({ text: '评论区文案', source: 'copied' })
            });

            assert.equal(result.source, 'copied');
            assert.equal(result.text, '评论区文案');
            assert.equal(result.aiFailed, true);
        }
    });
});

test('复制评论过滤 UP 主、空内容、屏蔽词和重复内容', () => {
    const comments = [
        ['UP主', 'UP主自己的评论'],
        ['普通用户', '谢谢分享'],
        ['另一个用户', '谢谢分享'],
        ['广告用户', '这是广告文案'],
        ['正则用户', '测试命中'],
        ['空内容用户', '   ']
    ];

    assert.deepEqual(filterCopiedComments(comments, ['广告', '^测试'], ' UP主 '), [['普通用户', '谢谢分享']]);
    assert.equal(renderCopiedComment(['UP主', '感谢 UP主'], '我的昵称'), '感谢 我的昵称');
});

test('无可用复制评论时依次回退备用评论和固定评论', async () => {
    await withEnvironment({ ENABLE_AI_COMMENTS: undefined, AI_FALLBACK_COMMENT: '备用评论' }, async () => {
        const fallback = await buildComment({ rid: 'rid-1', chat_type: 17, uname: 'UP主' }, {
            config: { is_copy_chat: false, copy_chat_on_ai_failure: true, chat: ['固定评论'] },
            fetchCopiedComment: async () => null
        });
        assert.deepEqual(fallback, { text: '备用评论', source: 'fallback', aiFailed: true });
    });

    await withEnvironment({ ENABLE_AI_COMMENTS: undefined, AI_FALLBACK_COMMENT: undefined }, async () => {
        const fixed = await buildComment({ rid: 'rid-1', chat_type: 17, uname: 'UP主' }, {
            config: { is_copy_chat: false, copy_chat_on_ai_failure: true, chat: ['给 ${uname} 的评论'] },
            fetchCopiedComment: async () => null
        });
        assert.deepEqual(fixed, { text: '给 UP主 的评论', source: 'configured', aiFailed: true });
    });
});

test('关闭 AI 失败复制后不会读取评论区', async () => {
    await withEnvironment({ ENABLE_AI_COMMENTS: undefined }, async () => {
        let copyCalls = 0;
        const result = await buildComment({ rid: 'rid-1', chat_type: 17 }, {
            config: { is_copy_chat: false, copy_chat_on_ai_failure: false, chat: ['固定评论'] },
            fetchCopiedComment: async () => {
                copyCalls += 1;
                return { text: '不应读取', source: 'copied' };
            }
        });

        assert.equal(copyCalls, 0);
        assert.equal(result.text, '固定评论');
        assert.equal(result.source, 'configured');
    });
});
