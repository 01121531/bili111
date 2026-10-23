const test = require('node:test');
const assert = require('node:assert/strict');
const bili = require('../../lib/net/bili');
const config = require('../../lib/data/config');
const { Monitor } = require('../../lib/core/monitor');
const { VideoShareController } = require('../../lib/helper/video_share');

function controller(options = {}) {
    return new VideoShareController({
        config: {
            share_video_every_forwards: 0,
            share_video_count_per_trigger: 0,
            share_video_after_run: 0,
            random_dynamic_wait: 0,
            ...options.config
        },
        getRecommendations: options.getRecommendations,
        shareVideo: options.shareVideo,
        maxRecommendationCalls: options.maxRecommendationCalls
    });
}

test('只按成功转发边界触发分享并在任务结束后完成最终分享', async () => {
    const shared = [];
    const item = controller({
        config: {
            share_video_every_forwards: 2,
            share_video_count_per_trigger: 2,
            share_video_after_run: 1
        },
        getRecommendations: async () => [[1, 101], [2, 102], [3, 103], [4, 104], [5, 105]],
        shareVideo: async (_uid, aid) => {
            shared.push(aid);
            return { status: 'success', reason: '分享成功' };
        }
    });

    assert.equal((await item.recordSuccessfulForward()).triggered, false);
    assert.deepEqual(await item.recordSuccessfulForward(), { triggered: true, shared: 2, successfulForwards: 2 });
    assert.equal((await item.recordSuccessfulForward()).triggered, false);
    assert.deepEqual(await item.recordSuccessfulForward(), { triggered: true, shared: 2, successfulForwards: 4 });
    assert.deepEqual(await item.finish(), { shared: 1, alreadyFinished: false });
    assert.deepEqual(shared, [101, 102, 103, 104, 105]);
    assert.deepEqual(await item.finish(), { shared: 0, alreadyFinished: true });
});

test('不可分享或分享失败的候选会继续尝试其他视频', async () => {
    const attempts = [];
    const item = controller({
        config: { share_video_every_forwards: 1, share_video_count_per_trigger: 1 },
        getRecommendations: async () => [[1, 201], [2, 202], [3, 203]],
        shareVideo: async (_uid, aid) => {
            attempts.push(aid);
            if (aid === 201) return { status: 'skipped', reason: '该视频当前不可分享' };
            if (aid === 202) return { status: 'failed', reason: 'B站返回 4126021（等级不足）' };
            return { status: 'success', reason: '分享成功' };
        }
    });

    assert.deepEqual(await item.recordSuccessfulForward(), { triggered: true, shared: 1, successfulForwards: 1 });
    assert.deepEqual(attempts, [201, 202, 203]);
});

test('推荐视频按 ID 去重且空响应或非法响应不会无限请求', async () => {
    const seenRecommendationCalls = [];
    const item = controller({
        config: { share_video_every_forwards: 1, share_video_count_per_trigger: 2 },
        maxRecommendationCalls: 2,
        getRecommendations: async () => {
            seenRecommendationCalls.push(Date.now());
            return [[1, 301], [2, 301], [0, 0], ['bad', 302]];
        },
        shareVideo: async () => ({ status: 'success', reason: '分享成功' })
    });

    const result = await item.recordSuccessfulForward();
    assert.equal(result.shared, 1);
    assert.equal(seenRecommendationCalls.length, 2);
    assert.deepEqual(item.sharedVideoIds, [301]);

    let emptyCalls = 0;
    const empty = controller({
        config: { share_video_every_forwards: 1, share_video_count_per_trigger: 1 },
        getRecommendations: async () => {
            emptyCalls += 1;
            return [];
        },
        shareVideo: async () => ({ status: 'success', reason: '分享成功' })
    });
    assert.equal((await empty.recordSuccessfulForward()).shared, 0);
    assert.equal(emptyCalls, 1);
});

test('视频分享失败不会抛出异常或回滚转发结果', async () => {
    const item = controller({
        config: { share_video_every_forwards: 1, share_video_count_per_trigger: 1 },
        getRecommendations: async () => [[1, 401]],
        shareVideo: async () => {
            throw new Error('本地进程异常');
        }
    });

    assert.deepEqual(await item.recordSuccessfulForward(), { triggered: true, shared: 0, successfulForwards: 1 });
});

test('旧布尔分享接口保持兼容：false 表示成功，true 表示失败', async () => {
    const successful = controller({
        config: { share_video_every_forwards: 1, share_video_count_per_trigger: 1 },
        getRecommendations: async () => [[1, 451]],
        shareVideo: async () => false
    });
    assert.deepEqual(await successful.recordSuccessfulForward(), { triggered: true, shared: 1, successfulForwards: 1 });

    const failed = controller({
        config: { share_video_every_forwards: 1, share_video_count_per_trigger: 1 },
        getRecommendations: async () => [[1, 452]],
        shareVideo: async () => true
    });
    assert.deepEqual(await failed.recordSuccessfulForward(), { triggered: true, shared: 0, successfulForwards: 1 });
});

test('discover 不创建视频分享控制器且不执行任何参与写操作', async () => {
    const previous = {
        NOT_GO_LOTTERY: process.env.NOT_GO_LOTTERY,
        minfollower: config.minfollower,
        wait: config.wait,
        filter_wait: config.filter_wait,
        create_dy: config.create_dy
    };
    process.env.NOT_GO_LOTTERY = '1';
    config.minfollower = 0;
    config.wait = 0;
    config.filter_wait = 0;
    config.create_dy = false;
    const writes = [];
    const originals = {
        sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed,
        autoAttentionDetailed: bili.autoAttentionDetailed,
        autolikeDetailed: bili.autolikeDetailed,
        autoRelayDetailed: bili.autoRelayDetailed,
        shareVideoDetailed: bili.shareVideoDetailed
    };
    bili.sendChatWithOcrDetailed = async () => { writes.push('comment'); return {}; };
    bili.autoAttentionDetailed = async () => { writes.push('follow'); return {}; };
    bili.autolikeDetailed = async () => { writes.push('like'); return {}; };
    bili.autoRelayDetailed = async () => { writes.push('relay'); return {}; };
    bili.shareVideoDetailed = async () => { writes.push('share'); return {}; };
    try {
        const taskContext = {};
        const monitor = new Monitor([], taskContext);
        monitor.filterLotteryInfo = async () => [{
            uid: ['123'],
            dyid: '800000001',
            rid: 'rid-1',
            chat_type: 17,
            chat: '演练评论',
            relay_chat: '演练转发',
            ctrl: [],
            isOfficialLottery: false,
            drawtime: Date.now() / 1000 + 86400,
            drawTimeSource: 'text'
        }];
        await monitor.startLottery();

        assert.equal(taskContext.videoShareController, undefined);
        assert.deepEqual(writes, []);
    } finally {
        Object.assign(bili, originals);
        if (previous.NOT_GO_LOTTERY === undefined) delete process.env.NOT_GO_LOTTERY;
        else process.env.NOT_GO_LOTTERY = previous.NOT_GO_LOTTERY;
        config.minfollower = previous.minfollower;
        config.wait = previous.wait;
        config.filter_wait = previous.filter_wait;
        config.create_dy = previous.create_dy;
    }
});

test('抽奖任务只在转发成功时增加视频分享计数', async () => {
    const previous = {
        NOT_GO_LOTTERY: process.env.NOT_GO_LOTTERY,
        minfollower: config.minfollower,
        wait: config.wait,
        filter_wait: config.filter_wait,
        create_dy: config.create_dy
    };
    delete process.env.NOT_GO_LOTTERY;
    config.minfollower = 0;
    config.wait = 0;
    config.filter_wait = 0;
    config.create_dy = false;
    try {
        const calls = [];
        const taskContext = {
            videoShareController: {
                recordSuccessfulForward: async () => { calls.push('record'); return { triggered: false }; },
                finish: async () => ({ shared: 0 })
            }
        };
        const monitor = new Monitor([], taskContext);
        monitor.filterLotteryInfo = async () => [
            { uid: ['123'], dyid: '800000001', isOfficialLottery: false, drawtime: Date.now() / 1000 + 86400, drawTimeSource: 'text' },
            { uid: ['124'], dyid: '800000002', isOfficialLottery: false, drawtime: Date.now() / 1000 + 86400, drawTimeSource: 'text' }
        ];
        const results = [
            { code: 0, overallStatus: 'success', reason: '成功', relay: { status: 'success' } },
            { code: 5004, overallStatus: 'partial', reason: '转发失败', relay: { status: 'failed' } }
        ];
        monitor.go = async () => results.shift();

        await monitor.startLottery();
        assert.deepEqual(calls, ['record']);
    } finally {
        if (previous.NOT_GO_LOTTERY === undefined) delete process.env.NOT_GO_LOTTERY;
        else process.env.NOT_GO_LOTTERY = previous.NOT_GO_LOTTERY;
        config.minfollower = previous.minfollower;
        config.wait = previous.wait;
        config.filter_wait = previous.filter_wait;
        config.create_dy = previous.create_dy;
    }
});
