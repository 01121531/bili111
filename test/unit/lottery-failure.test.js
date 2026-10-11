const test = require('node:test');
const assert = require('node:assert/strict');
const eventBus = require('../../lib/helper/event_bus');
const globalVar = require('../../lib/data/global_var');
const bili = require('../../lib/net/bili');
const config = require('../../lib/data/config');
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

test('分区获取失败会拒绝任务而不是假成功', async () => {
    const originalCheckMyPartition = bili.checkMyPartition;
    const originalConfig = {
        model: config.model,
        partition_id: config.partition_id,
        is_not_create_partition: config.is_not_create_partition
    };
    process.env.NUMBER = '1';
    delete process.env.NOT_GO_LOTTERY;
    config.model = '11';
    config.partition_id = undefined;
    config.is_not_create_partition = false;
    globalVar.set('Lottery', [['UIDs', '1']]);
    bili.checkMyPartition = async () => undefined;

    try {
        await assert.rejects(start('1'), /分区获取失败/);
    } finally {
        bili.checkMyPartition = originalCheckMyPartition;
        Object.assign(config, originalConfig);
        eventBus.flush();
    }
});

test('仅发现模式在不过滤关注账号时跳过分区和关注列表请求', async () => {
    const originalCheckMyPartition = bili.checkMyPartition;
    const originalGetAttentionList = bili.getAttentionList;
    const originalStartLottery = Monitor.prototype.startLottery;
    const originalConfig = {
        model: config.model,
        only_followed: config.only_followed,
        partition_id: config.partition_id,
        is_not_create_partition: config.is_not_create_partition
    };
    let partitionCalls = 0;
    let followingCalls = 0;
    process.env.NOT_GO_LOTTERY = '1';
    config.model = '11';
    config.only_followed = false;
    config.partition_id = undefined;
    config.is_not_create_partition = false;
    bili.checkMyPartition = async () => { partitionCalls += 1; return 1; };
    bili.getAttentionList = async () => { followingCalls += 1; return new Set(); };
    Monitor.prototype.startLottery = async () => 0;

    try {
        await new Monitor(['FollowFeed', 1], {}).init();
        assert.equal(partitionCalls, 0);
        assert.equal(followingCalls, 0);
    } finally {
        delete process.env.NOT_GO_LOTTERY;
        bili.checkMyPartition = originalCheckMyPartition;
        bili.getAttentionList = originalGetAttentionList;
        Monitor.prototype.startLottery = originalStartLottery;
        Object.assign(config, originalConfig);
        eventBus.flush();
    }
});

test('同一任务的多个来源共享分区和关注列表', async () => {
    const originalCheckMyPartition = bili.checkMyPartition;
    const originalGetAttentionList = bili.getAttentionList;
    const originalStartLottery = Monitor.prototype.startLottery;
    const originalConfig = {
        model: config.model,
        only_followed: config.only_followed,
        partition_id: config.partition_id,
        is_not_create_partition: config.is_not_create_partition
    };
    let partitionCalls = 0;
    let followingCalls = 0;
    const context = {};
    delete process.env.NOT_GO_LOTTERY;
    config.model = '11';
    config.only_followed = false;
    config.partition_id = undefined;
    config.is_not_create_partition = false;
    bili.checkMyPartition = async () => { partitionCalls += 1; return 123; };
    bili.getAttentionList = async () => { followingCalls += 1; return new Set(['1']); };
    Monitor.prototype.startLottery = async () => 0;

    try {
        await new Monitor(['FollowFeed', 1], context).init();
        await new Monitor(['ArticleUIDs', '1'], context).init();
        assert.equal(partitionCalls, 1);
        assert.equal(followingCalls, 1);
    } finally {
        bili.checkMyPartition = originalCheckMyPartition;
        bili.getAttentionList = originalGetAttentionList;
        Monitor.prototype.startLottery = originalStartLottery;
        Object.assign(config, originalConfig);
        eventBus.flush();
    }
});
