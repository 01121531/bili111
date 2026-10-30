const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJsonObject, requestJsonObject } = require('../../lib/helper/ai_response');

test('AI 返回内容可解析 JSON、Markdown 代码块和夹带解释的对象', () => {
    assert.deepEqual(extractJsonObject('{"has_key_words":true}'), { has_key_words: true });
    assert.deepEqual(extractJsonObject('```json\n{"needAt":true}\n```'), { needAt: true });
    assert.deepEqual(
        extractJsonObject('判断如下：{"has_key_words":false,"more":"普通动态"}，请参考。'),
        { has_key_words: false, more: '普通动态' }
    );
});

test('AI 返回 null、数组、空内容或损坏 JSON 时安全降级', () => {
    for (const value of [null, '', 'null', '[]', '```json\nnull\n```', '{"has_key_words":']) {
        assert.equal(extractJsonObject(value), null);
    }
});

test('AI JSON 首次成功时不重试', async () => {
    const calls = [];
    const result = await requestJsonObject(async request => {
        calls.push(request);
        return '{"has_key_words":true}';
    });

    assert.deepEqual(result, { value: { has_key_words: true }, attempts: 1, retried: false });
    assert.deepEqual(calls, [{ attempt: 1, strict: false }]);
});

test('AI JSON 解析失败后使用严格格式重试一次', async () => {
    const calls = [];
    const result = await requestJsonObject(async request => {
        calls.push(request);
        return request.strict ? '{"has_key_words":false}' : '无法确认，请结合正文判断。';
    });

    assert.deepEqual(result, { value: { has_key_words: false }, attempts: 2, retried: true });
    assert.deepEqual(calls, [
        { attempt: 1, strict: false },
        { attempt: 2, strict: true },
    ]);
});

test('AI JSON 两次均失败或请求异常时安全降级', async () => {
    const result = await requestJsonObject(async () => {
        throw new Error('temporary failure');
    });

    assert.deepEqual(result, { value: null, attempts: 2, retried: true });
});

test('AI JSON 请求上限只允许一次尝试时不额外请求', async () => {
    let calls = 0;
    const result = await requestJsonObject(async () => {
        calls += 1;
        return 'not json';
    }, 1);

    assert.deepEqual(result, { value: null, attempts: 1, retried: false });
    assert.equal(calls, 1);
});
