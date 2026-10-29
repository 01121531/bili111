const test = require('node:test');
const assert = require('node:assert/strict');
const bili = require('../../lib/net/bili');
const config = require('../../lib/data/config');
const { Monitor } = require('../../lib/core/monitor');
const { randomDynamic } = require('../../lib/helper/randomDynamic');
const { VideoShareController, newVideoShareRulesConfigured } = require('../../lib/helper/video_share');

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
        maxRecommendationCalls: options.maxRecommendationCalls,
        shareInterval: options.shareInterval ?? 0
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

test('任一新版视频分享规则启用时不再使用旧版随机动态分享入口', () => {
    assert.equal(newVideoShareRulesConfigured({
        share_video_every_forwards: 0,
        share_video_count_per_trigger: 0,
        share_video_after_run: 0
    }), false);
    assert.equal(newVideoShareRulesConfigured({
        share_video_every_forwards: 3,
        share_video_count_per_trigger: 0,
        share_video_after_run: 0
    }), true);
    assert.equal(newVideoShareRulesConfigured({
        share_video_every_forwards: 0,
        share_video_count_per_trigger: 0,
        share_video_after_run: 2
    }), true);
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

test('视频分享触发 B 站限流后停止候选、后续触发和结束分享', async () => {
    const attempts = [];
    const item = controller({
        config: { share_video_every_forwards: 1, share_video_count_per_trigger: 3, share_video_after_run: 2 },
        getRecommendations: async () => [[1, 501], [2, 502], [3, 503], [4, 504], [5, 505]],
        shareVideo: async (_uid, aid) => {
            attempts.push(aid);
            return {
                status: 'failed',
                providerCode: 4128002,
                providerMessage: '操作太频繁了，请稍后重试',
                reason: 'B站返回 4128002（操作太频繁了，请稍后重试）'
            };
        }
    });

    assert.deepEqual(await item.recordSuccessfulForward(), { triggered: true, shared: 0, successfulForwards: 1 });
    assert.deepEqual(await item.recordSuccessfulForward(), { triggered: true, shared: 0, successfulForwards: 2 });
    assert.deepEqual(await item.finish(), { shared: 0, alreadyFinished: false });
    assert.deepEqual(attempts, [501]);
});

test('账号等级不足时停止本轮后续视频分享，避免逐个候选重复失败', async () => {
    const attempts = [];
    const item = controller({
        config: { share_video_every_forwards: 1, share_video_count_per_trigger: 3, share_video_after_run: 2 },
        getRecommendations: async () => [[1, 601], [2, 602], [3, 603], [4, 604]],
        shareVideo: async (_uid, aid) => {
            attempts.push(aid);
            return {
                status: 'failed',
                providerCode: 4126021,
                providerMessage: '等级不足无法发送，快去努力升级吧',
                reason: 'B站返回 4126021（等级不足无法发送，快去努力升级吧）'
            };
        }
    });

    assert.deepEqual(await item.recordSuccessfulForward(), { triggered: true, shared: 0, successfulForwards: 1 });
    assert.deepEqual(await item.recordSuccessfulForward(), { triggered: true, shared: 0, successfulForwards: 2 });
    assert.deepEqual(await item.finish(), { shared: 0, alreadyFinished: false });
    assert.deepEqual(attempts, [601]);
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

test('新版分享配置启用时抽奖循环不调用旧版视频分享接口', { concurrency: false }, async () => {
    const previous = {
        NOT_GO_LOTTERY: process.env.NOT_GO_LOTTERY,
        minfollower: config.minfollower,
        wait: config.wait,
        filter_wait: config.filter_wait,
        create_dy: config.create_dy,
        create_dy_mode: config.create_dy_mode,
        create_dy_type: config.create_dy_type,
        random_dynamic_wait: config.random_dynamic_wait,
        share_video_every_forwards: config.share_video_every_forwards,
        share_video_count_per_trigger: config.share_video_count_per_trigger,
        share_video_after_run: config.share_video_after_run
    };
    const originalGetTopRcmd = bili.getTopRcmd;
    delete process.env.NOT_GO_LOTTERY;
    Object.assign(config, {
        minfollower: 0,
        wait: 0,
        filter_wait: 0,
        create_dy: true,
        create_dy_mode: [[1], [1]],
        create_dy_type: 1,
        random_dynamic_wait: 0,
        share_video_every_forwards: 3,
        share_video_count_per_trigger: 3,
        share_video_after_run: 5
    });
    let legacyRecommendationCalls = 0;
    bili.getTopRcmd = async () => {
        legacyRecommendationCalls += 1;
        return [[1, 701], [2, 702]];
    };
    try {
        const forwarded = [];
        const taskContext = {
            videoShareController: {
                recordSuccessfulForward: async () => {
                    forwarded.push('record');
                    return { triggered: false };
                },
                finish: async () => ({ shared: 0 })
            }
        };
        const monitor = new Monitor([], taskContext);
        monitor.filterLotteryInfo = async () => [
            { uid: ['123'], dyid: '810000001', isOfficialLottery: false, drawtime: Date.now() / 1000 + 86400, drawTimeSource: 'text' },
            { uid: ['124'], dyid: '810000002', isOfficialLottery: false, drawtime: Date.now() / 1000 + 86400, drawTimeSource: 'text' }
        ];
        monitor.go = async () => ({ code: 0, overallStatus: 'success', reason: '成功', relay: { status: 'success' } });

        await monitor.startLottery();

        assert.equal(legacyRecommendationCalls, 0);
        assert.deepEqual(forwarded, ['record', 'record']);
    } finally {
        bili.getTopRcmd = originalGetTopRcmd;
        if (previous.NOT_GO_LOTTERY === undefined) delete process.env.NOT_GO_LOTTERY;
        else process.env.NOT_GO_LOTTERY = previous.NOT_GO_LOTTERY;
        for (const key of Object.keys(previous)) {
            if (key !== 'NOT_GO_LOTTERY') config[key] = previous[key];
        }
    }
});

test('旧版视频分享兼容路径成功时保持原行为，限流时立即停止', { concurrency: false }, async () => {
    const previous = {
        create_dy_type: config.create_dy_type,
        random_dynamic_wait: config.random_dynamic_wait
    };
    const originalGetTopRcmd = bili.getTopRcmd;
    const originalShareVideoDetailed = bili.shareVideoDetailed;
    config.create_dy_type = 1;
    config.random_dynamic_wait = 0;
    bili.getTopRcmd = async () => [[1, 711], [2, 712]];
    try {
        const successfulAttempts = [];
        bili.shareVideoDetailed = async (_uid, aid) => {
            successfulAttempts.push(aid);
            return { status: 'success', reason: '分享成功' };
        };
        await randomDynamic(2);
        assert.equal(successfulAttempts.length, 2);

        const limitedAttempts = [];
        bili.shareVideoDetailed = async (_uid, aid) => {
            limitedAttempts.push(aid);
            return {
                status: 'failed',
                providerCode: 4128002,
                providerMessage: '操作太频繁了，请稍后重试',
                reason: 'B站返回 4128002（操作太频繁了，请稍后重试）'
            };
        };
        await randomDynamic(2);
        assert.equal(limitedAttempts.length, 1);
    } finally {
        bili.getTopRcmd = originalGetTopRcmd;
        bili.shareVideoDetailed = originalShareVideoDetailed;
        config.create_dy_type = previous.create_dy_type;
        config.random_dynamic_wait = previous.random_dynamic_wait;
    }
});
