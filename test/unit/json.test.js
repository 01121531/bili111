const test = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../../lib/utils');

test('HTTP 错误占位文本不会触发 JSON 解析堆栈', () => {
    const originalError = utils.log.error;
    let errorCalls = 0;
    utils.log.error = () => { errorCalls += 1; };
    try {
        assert.deepEqual(utils.strToJson('[响应错误]HTTP状态码:412'), {});
        assert.equal(errorCalls, 0);
    } finally {
        utils.log.error = originalError;
    }
});
