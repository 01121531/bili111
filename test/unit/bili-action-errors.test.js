const test = require('node:test');
const assert = require('node:assert/strict');
const bili = require('../../lib/net/bili');
const detailedResult = bili.__testDetailedResult;

test('评论保留已知与未知 B 站错误码和真实信息', async t => {
    const mappings = { [-107]: { internalCode: 13, message: '账号未转正' } };
    await t.test('账号未转正', () => {
            const result = detailedResult('comment', { ok: true, body: JSON.stringify({ code: -107, message: '账号未转正' }), httpStatus: 200 }, mappings);
            assert.equal(result.internalCode, 13);
            assert.equal(result.providerCode, -107);
            assert.equal(result.providerMessage, '账号未转正');
            assert.equal(result.errorType, 'bili_api');
            assert.match(result.reason, /-107.*账号未转正/);
        });
    await t.test('未知新错误码', () => {
            const result = detailedResult('comment', { ok: true, body: JSON.stringify({ code: 987654, message: '新的限制原因' }), httpStatus: 200 }, mappings);
            assert.equal(result.internalCode, 1);
            assert.equal(result.providerCode, 987654);
            assert.equal(result.providerMessage, '新的限制原因');
            assert.match(result.reason, /987654.*新的限制原因/);
        });
});

test('转发保留等级不足的 B 站错误详情', async () => {
    const result = detailedResult('relay', { ok: true, body: JSON.stringify({ code: 4126021, message: '等级不足无法发送，快去努力升级吧' }), httpStatus: 200 }, { 4126021: { internalCode: 6 } });
    assert.equal(result.internalCode, 6);
    assert.equal(result.providerCode, 4126021);
    assert.equal(result.providerMessage, '等级不足无法发送，快去努力升级吧');
});

test('HTTP、响应格式和网络错误保留诊断字段且不泄露请求内容', async t => {
    await t.test('HTTP 429 与 B 站响应并存', () => {
            const result = detailedResult('comment', { ok: false, body: JSON.stringify({ code: -509, message: '请求过于频繁' }), httpStatus: 429, errorType: 'http', errorMessage: 'HTTP错误' });
            assert.equal(result.errorType, 'http');
            assert.equal(result.httpStatus, 429);
            assert.equal(result.providerCode, -509);
            assert.equal(result.providerMessage, '请求过于频繁');
            assert.equal(result.retryable, true);
            assert.doesNotMatch(JSON.stringify(result), /cookie|csrf|敏感输入/);
        });
    await t.test('非 JSON 响应', () => {
            const result = detailedResult('comment', { ok: true, body: '<html>blocked</html>', httpStatus: 200 });
            assert.equal(result.errorType, 'parse');
            assert.match(result.reason, /响应格式异常/);
        });
    await t.test('连接拒绝', () => {
            const result = detailedResult('comment', { ok: false, body: '', httpStatus: null, errorType: 'network', transportCode: 'ECONNREFUSED', errorMessage: 'connect ECONNREFUSED' });
            assert.equal(result.errorType, 'network');
            assert.equal(result.transportCode, 'ECONNREFUSED');
            assert.equal(result.retryable, true);
        });
});
