const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJsonObject } = require('../../lib/helper/ai_response');

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
