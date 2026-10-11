const test = require('node:test');
const assert = require('node:assert/strict');
const eventBus = require('../../lib/helper/event_bus');
const globalVar = require('../../lib/data/global_var');
const { Monitor } = require('../../lib/core/monitor');
const { start } = require('../../lib/lottery');

test('关注列表致命错误会拒绝抽奖任务', async () => {
    const originalInit = Monitor.prototype.init;
    process.env.NUMBER = '1';
    globalVar.set('Lottery', [['UIDs', '1']]);
    Monitor.prototype.init = async function () {
        eventBus.emit('Turn_off_the_Monitor', new Error('关注列表不可用'));
    };

    try {
        await assert.rejects(start('1'), /关注列表不可用/);
    } finally {
        Monitor.prototype.init = originalInit;
        eventBus.flush();
    }
});

test('没有配置任何抽奖来源会明确失败', async () => {
    process.env.NUMBER = '1';
    globalVar.set('Lottery', []);
    await assert.rejects(start('1'), /未配置任何抽奖来源/);
    eventBus.flush();
});
