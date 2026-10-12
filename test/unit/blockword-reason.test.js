const test = require('node:test');
const assert = require('node:assert/strict');
const { getMatchedBlockwords, blockwordReason } = require('../../lib/core/monitor');

test('屏蔽词原因列出所有正文命中的配置项并去重', () => {
    const matches = getMatchedBlockwords(['脚本', '抽奖号', '脚本', '未命中'], '这是抽奖号，禁止脚本参与');
    assert.deepEqual(matches, ['脚本', '抽奖号']);
    assert.equal(blockwordReason(matches), '正文命中屏蔽词：脚本、抽奖号');
});

test('屏蔽词支持正则、预约文本和非法正则不会中断筛选', () => {
    const matches = getMatchedBlockwords(['钓鱼|诈骗', '[', '', '预约'], '预约抽奖请注意钓鱼风险');
    assert.deepEqual(matches, ['钓鱼|诈骗', '预约']);
    assert.equal(blockwordReason([]), '正文命中屏蔽词');
});

test('屏蔽词原因最多展示 20 项并标记剩余数量', () => {
    const words = Array.from({ length: 21 }, (_, index) => `词${index + 1}`);
    assert.equal(blockwordReason(words), `正文命中屏蔽词：${words.slice(0, 20).join('、')}、等1项`);
});
