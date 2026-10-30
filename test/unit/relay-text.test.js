const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRelayText, inspectRelayText, MAX_RELAY_LENGTH } = require('../../lib/helper/relay_text');

function runtimeConfig(overrides = {}) {
    return {
        relay: ['固定转发附言'],
        ai_relay_parm: {
            url: 'https://ai.example.test/v1/chat/completions',
            body: { model: 'test' },
            prompt: '为 av{video_id} 生成转发附言'
        },
        ...overrides
    };
}

function withEnvironment(values, run) {
    const keys = ['ENABLE_AI_RELAY', 'AI_FALLBACK_RELAY', 'AI_SENSITIVE_WORDS', 'AI_ALLOW_EMPTY_RELAY'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    return Promise.resolve()
        .then(run)
        .finally(() => {
            for (const key of keys) {
                if (previous[key] === undefined) delete process.env[key];
                else process.env[key] = previous[key];
            }
        });
}

test('推荐视频附言优先使用 AI 并记录来源', { concurrency: false }, async () => {
    await withEnvironment({ ENABLE_AI_RELAY: '1' }, async () => {
        let prompt = '';
        const result = await buildRelayText({
            config: runtimeConfig(),
            videoId: '12345',
            videoUid: '67890',
            accountName: '测试账号',
            getAiContent: async (_url, _body, value) => {
                prompt = value;
                return '这个视频很有意思，分享给大家。';
            }
        });

        assert.deepEqual(result, {
            text: '这个视频很有意思，分享给大家。',
            source: 'ai',
            aiAttempted: true
        });
        assert.match(prompt, /av12345/);
    });
});

test('AI 不可用时依次使用备用附言和账号固定附言', { concurrency: false }, async () => {
    await withEnvironment({ ENABLE_AI_RELAY: '1', AI_FALLBACK_RELAY: 'AI 失败备用附言' }, async () => {
        const fallback = await buildRelayText({
            config: runtimeConfig(),
            videoId: '1',
            videoUid: '2',
            getAiContent: async () => {
                throw new Error('AI 服务超时');
            }
        });
        assert.equal(fallback.text, 'AI 失败备用附言');
        assert.equal(fallback.source, 'fallback');
    });

    await withEnvironment({}, async () => {
        const configured = await buildRelayText({
            config: runtimeConfig(),
            videoId: '1',
            videoUid: '2',
            getAiContent: async () => {
                throw new Error('不应调用 AI');
            }
        });
        assert.equal(configured.text, '固定转发附言');
        assert.equal(configured.source, 'configured');
        assert.equal(configured.aiAttempted, false);
    });
});

test('AI 附言为空、敏感或超长时安全降级', { concurrency: false }, async () => {
    await withEnvironment({
        ENABLE_AI_RELAY: '1',
        AI_SENSITIVE_WORDS: JSON.stringify(['违规词'])
    }, async () => {
        const sensitive = await buildRelayText({
            config: runtimeConfig({ relay: ['安全的固定附言'] }),
            videoId: '1',
            videoUid: '2',
            getAiContent: async () => '包含违规词的附言'
        });
        assert.equal(sensitive.text, '安全的固定附言');
        assert.equal(sensitive.source, 'safety_fallback');

        const tooLong = await buildRelayText({
            config: runtimeConfig({ relay: ['长度安全的固定附言'] }),
            videoId: '1',
            videoUid: '2',
            getAiContent: async () => '长'.repeat(MAX_RELAY_LENGTH + 1)
        });
        assert.equal(tooLong.text, '长度安全的固定附言');
        assert.equal(tooLong.source, 'safety_fallback');
    });

    await withEnvironment({ ENABLE_AI_RELAY: '1' }, async () => {
        const empty = await buildRelayText({
            config: runtimeConfig(),
            videoId: '1',
            videoUid: '2',
            getAiContent: async () => '   '
        });
        assert.equal(empty.text, '固定转发附言');
        assert.equal(empty.source, 'configured');
    });
});

test('附言检查不会把空内容或超长内容误判为可用', () => {
    assert.equal(inspectRelayText('', []).empty, true);
    assert.equal(inspectRelayText('  ', []).text, '');
    assert.equal(inspectRelayText('长'.repeat(MAX_RELAY_LENGTH), []).text.length, MAX_RELAY_LENGTH);
    assert.equal(inspectRelayText('长'.repeat(MAX_RELAY_LENGTH + 1), []).unsafe, true);
});
