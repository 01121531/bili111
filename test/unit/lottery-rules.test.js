const test = require('node:test');
const assert = require('node:assert/strict');
const { findBlockedLotteryUid, normalizeBlockedUids } = require('../../lib/helper/lottery_rules');

test('屏蔽抽奖发起人 UID 只使用实际发起人并清理非法重复值', () => {
    assert.deepEqual(normalizeBlockedUids([123, '456', 123, 0, -1, 1.5, 'bad']), [123, 456]);
    assert.equal(findBlockedLotteryUid(456, [123, 456]), 456);
    assert.equal(findBlockedLotteryUid('456', ['456']), 456);
    assert.equal(findBlockedLotteryUid(789, [123, 456]), null);
});

test('转发者 UID 不会被当成抽奖发起人命中', () => {
    const forwarderUid = 1001;
    const realLotteryUid = 2002;
    const blockedUids = [forwarderUid];

    assert.equal(findBlockedLotteryUid(realLotteryUid, blockedUids), null);
    assert.equal(findBlockedLotteryUid(forwarderUid, blockedUids), forwarderUid);
});
