const test = require('node:test');
const assert = require('node:assert/strict');
const bili = require('../../lib/net/bili');
const config = require('../../lib/data/config');
const globalVar = require('../../lib/data/global_var');
const { Monitor } = require('../../lib/core/monitor');

function option(overrides = {}) {
    return {
        uid: [], dyid: '500000001', rid: 'rid-1', chat_type: 17,
        chat: '计划评论', comment_source: 'ai', relay_chat: '计划转发附言', relay_source: 'fallback', ctrl: '[]',
        ...overrides
    };
}

function detailed(action, internalCode = 0, overrides = {}) {
    const status = internalCode ? 'failed' : 'success';
    const result = {
        action, status, internalCode, providerCode: internalCode ? -1 : 0,
        providerMessage: internalCode ? '测试错误' : '', errorType: internalCode ? 'bili_api' : null,
        httpStatus: 200, transportCode: null, retryable: false,
        targetId: action === 'follow' ? '902' : '500000001', occurredAt: new Date().toISOString(),
        reason: internalCode ? 'B站返回 -1（测试错误）' : '操作成功',
        ...overrides
    };
    result.attempts = overrides.attempts || [{ ...result }];
    return result;
}

test('参与动作返回实际评论、转发文案和来源', async () => {
    const originals = { sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed, autolikeDetailed: bili.autolikeDetailed, autoRelayDetailed: bili.autoRelayDetailed };
    const originalConfig = { check_if_duplicated: config.check_if_duplicated, is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    let commentCalls = 0; let relayedText = '';
    config.check_if_duplicated = 3; config.is_copy_chat = false; config.is_repost_then_chat = false;
    globalVar.set('myUID', '701');
    bili.sendChatWithOcrDetailed = async () => { commentCalls += 1; return detailed('comment', commentCalls === 1 ? 8 : 0); };
    bili.autolikeDetailed = async () => detailed('like');
    bili.autoRelayDetailed = async (_uid, _dyid, text) => { relayedText = text; return detailed('relay'); };
    try {
        const result = await new Monitor(['FollowFeed', 1]).go(option());
        assert.equal(result.code, 0); assert.equal(result.overallStatus, 'success');
        assert.equal(result.comment.plannedText, '计划评论');
        assert.equal(result.comment.actualText, '[doge][doge][doge][doge][doge]');
        assert.equal(result.comment.source, 'safety_fallback'); assert.equal(result.comment.status, 'success');
        assert.equal(result.relay.actualText, '计划转发附言'); assert.equal(result.relay.source, 'fallback');
        assert.equal(relayedText, '计划转发附言');
    } finally {
        Object.assign(bili, originals); Object.assign(config, originalConfig);
    }
});

test('前序动作成功而后续动作失败时标记为部分完成', async () => {
    const originals = { sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed, autolikeDetailed: bili.autolikeDetailed, autoRelayDetailed: bili.autoRelayDetailed };
    const originalConfig = { check_if_duplicated: config.check_if_duplicated, is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    config.check_if_duplicated = 3; config.is_copy_chat = false; config.is_repost_then_chat = false;
    bili.sendChatWithOcrDetailed = async () => detailed('comment');
    bili.autolikeDetailed = async () => detailed('like', 2, { providerCode: 1000113, providerMessage: '点赞异常', reason: 'B站返回 1000113（点赞异常）' });
    bili.autoRelayDetailed = async () => detailed('relay');
    try {
        const result = await new Monitor(['FollowFeed', 1]).go(option());
        assert.equal(result.code, 4002); assert.equal(result.overallStatus, 'partial');
        assert.equal(result.comment.status, 'success'); assert.equal(result.like.status, 'failed');
        assert.equal(result.relay.status, 'success'); assert.match(result.reason, /点赞失败/);
    } finally {
        Object.assign(bili, originals); Object.assign(config, originalConfig);
    }
});

test('关注失败后仍继续点赞、评论和转发，已点赞记为成功', async () => {
    const originals = { sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed, autoAttentionDetailed: bili.autoAttentionDetailed, autolikeDetailed: bili.autolikeDetailed, autoRelayDetailed: bili.autoRelayDetailed };
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat, is_not_create_partition: config.is_not_create_partition };
    config.is_copy_chat = false; config.is_repost_then_chat = false; config.is_not_create_partition = true;
    const calls = [];
    bili.sendChatWithOcrDetailed = async () => { calls.push('comment'); return detailed('comment'); };
    bili.autoAttentionDetailed = async () => { calls.push('follow'); return detailed('follow', 2, { providerCode: 22002, providerMessage: '您已被对方拉入黑名单', reason: 'B站返回 22002（您已被对方拉入黑名单）' }); };
    bili.autolikeDetailed = async () => { calls.push('like'); return detailed('like'); };
    bili.autoRelayDetailed = async () => { calls.push('relay'); return detailed('relay'); };
    try {
        const result = await new Monitor(['FollowFeed', 1]).go(option({ uid: ['902'], is_liked: false }));
        assert.equal(result.overallStatus, 'partial');
        assert.equal(result.follow.status, 'failed');
        assert.equal(result.like.status, 'success');
        assert.equal(result.comment.status, 'success');
        assert.equal(result.relay.status, 'success');
        assert.deepEqual(calls, ['comment', 'follow', 'like', 'relay']);
    } finally {
        Object.assign(bili, originals); Object.assign(config, originalConfig);
    }
});

test('补充评论模式只评论且重复评论不会改文案二次发送', async () => {
    const originals = { sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed, autoAttentionDetailed: bili.autoAttentionDetailed, autolikeDetailed: bili.autolikeDetailed, autoRelayDetailed: bili.autoRelayDetailed };
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    const calls = [];
    config.is_copy_chat = false; config.is_repost_then_chat = false;
    bili.sendChatWithOcrDetailed = async () => { calls.push('comment'); return detailed('comment', 9, { providerCode: 12051, providerMessage: '重复评论', reason: 'B站返回 12051（重复评论）' }); };
    bili.autoAttentionDetailed = async () => { calls.push('follow'); return detailed('follow'); };
    bili.autolikeDetailed = async () => { calls.push('like'); return detailed('like'); };
    bili.autoRelayDetailed = async () => { calls.push('relay'); return detailed('relay'); };
    try {
        const result = await new Monitor(['FollowFeed', 1]).go(option({ uid: ['902'], commentOnly: true }));
        assert.equal(result.overallStatus, 'success');
        assert.equal(result.comment.status, 'success');
        assert.match(result.comment.reason, /重复评论/);
        assert.equal(result.follow.status, 'not_required');
        assert.equal(result.like.status, 'not_required');
        assert.equal(result.relay.status, 'not_required');
        assert.deepEqual(calls, ['comment']);
    } finally {
        Object.assign(bili, originals); Object.assign(config, originalConfig);
    }
});

test('账号未转正的评论失败保存明确原因', async () => {
    const original = bili.sendChatWithOcrDetailed;
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    config.is_copy_chat = false; config.is_repost_then_chat = false;
    bili.sendChatWithOcrDetailed = async () => detailed('comment', 13, { providerCode: -107, providerMessage: '账号未转正', reason: 'B站返回 -107（账号未转正）' });
    try {
        const result = await new Monitor(['FollowFeed', 1]).go(option({ commentOnly: true }));
        assert.equal(result.code, 1013);
        assert.equal(result.overallStatus, 'failed');
        assert.equal(result.comment.code, 13);
        assert.equal(result.comment.reason, '评论失败：B站返回 -107（账号未转正）');
        assert.equal(result.reason, '评论失败：B站返回 -107（账号未转正）');
        assert.equal(result.comment.attempts[0].providerCode, -107);
    } finally {
        bili.sendChatWithOcrDetailed = original;
        Object.assign(config, originalConfig);
    }
});

test('多个动作失败时合并全部真实原因并保留各自尝试', async () => {
    const originals = { sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed, autolikeDetailed: bili.autolikeDetailed, autoRelayDetailed: bili.autoRelayDetailed };
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    config.is_copy_chat = false; config.is_repost_then_chat = false;
    bili.sendChatWithOcrDetailed = async () => detailed('comment', 13, { providerCode: -107, providerMessage: '账号未转正', reason: 'B站返回 -107（账号未转正）' });
    bili.autolikeDetailed = async () => detailed('like');
    bili.autoRelayDetailed = async () => detailed('relay', 6, { providerCode: 4126021, providerMessage: '等级不足无法发送，快去努力升级吧', reason: 'B站返回 4126021（等级不足无法发送，快去努力升级吧）' });
    try {
        const result = await new Monitor(['FollowFeed', 1]).go(option());
        assert.equal(result.overallStatus, 'partial');
        assert.match(result.reason, /评论失败：B站返回 -107/);
        assert.match(result.reason, /转发失败：B站返回 4126021/);
        assert.equal(result.comment.attempts[0].providerCode, -107);
        assert.equal(result.relay.attempts[0].providerCode, 4126021);
    } finally {
        Object.assign(bili, originals); Object.assign(config, originalConfig);
    }
});

test('多个关注目标分别保留目标和失败原因', async () => {
    const originals = { sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed, autoAttentionDetailed: bili.autoAttentionDetailed, autolikeDetailed: bili.autolikeDetailed, autoRelayDetailed: bili.autoRelayDetailed };
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat, is_not_create_partition: config.is_not_create_partition };
    config.is_copy_chat = false; config.is_repost_then_chat = false; config.is_not_create_partition = true;
    bili.sendChatWithOcrDetailed = async () => detailed('comment');
    bili.autoAttentionDetailed = async uid => detailed('follow', 2, { targetId: uid, providerCode: uid === '901' ? 22002 : 22003, providerMessage: uid === '901' ? '您已被对方拉入黑名单' : '黑名单用户无法关注', reason: uid === '901' ? 'B站返回 22002（您已被对方拉入黑名单）' : 'B站返回 22003（黑名单用户无法关注）' });
    bili.autolikeDetailed = async () => detailed('like');
    bili.autoRelayDetailed = async () => detailed('relay');
    try {
        const result = await new Monitor(['FollowFeed', 1]).go(option({ uid: ['901', '902'] }));
        assert.equal(result.follow.status, 'failed');
        assert.match(result.follow.reason, /22002/);
        assert.match(result.follow.reason, /22003/);
        assert.deepEqual(result.follow.attempts.map(item => item.targetId), ['901', '902']);
    } finally {
        Object.assign(bili, originals); Object.assign(config, originalConfig);
    }
});

test('账号未转正后本轮停止后续评论请求，但继续点赞和转发', async () => {
    const originals = { sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed, autolikeDetailed: bili.autolikeDetailed, autoRelayDetailed: bili.autoRelayDetailed };
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    config.is_copy_chat = false; config.is_repost_then_chat = false;
    const calls = [];
    const taskContext = {};
    bili.sendChatWithOcrDetailed = async () => {
        calls.push('comment');
        return detailed('comment', 13, { providerCode: -107, providerMessage: '账号未转正', reason: 'B站返回 -107（账号未转正）' });
    };
    bili.autolikeDetailed = async () => { calls.push('like'); return detailed('like'); };
    bili.autoRelayDetailed = async () => { calls.push('relay'); return detailed('relay'); };
    try {
        const first = await new Monitor(['FollowFeed', 1], taskContext).go(option({ dyid: '500000001', rid: 'rid-1' }));
        const second = await new Monitor(['FollowFeed', 1], taskContext).go(option({ dyid: '500000002', rid: 'rid-2' }));
        assert.equal(first.overallStatus, 'partial');
        assert.equal(second.overallStatus, 'partial');
        assert.equal(second.comment.status, 'failed');
        assert.match(second.comment.reason, /B站返回 -107（账号未转正）/);
        assert.match(second.comment.reason, /本轮后续评论请求已停止/);
        assert.equal(second.comment.attempts.length, 0);
        assert.equal(second.like.status, 'success');
        assert.equal(second.relay.status, 'success');
        assert.deepEqual(calls, ['comment', 'like', 'relay', 'like', 'relay']);
    } finally {
        Object.assign(bili, originals); Object.assign(config, originalConfig);
    }
});

test('转发等级不足后本轮停止后续转发请求，但继续评论和点赞', async () => {
    const originals = { sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed, autolikeDetailed: bili.autolikeDetailed, autoRelayDetailed: bili.autoRelayDetailed };
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    config.is_copy_chat = false; config.is_repost_then_chat = false;
    const calls = [];
    const taskContext = {};
    bili.sendChatWithOcrDetailed = async () => { calls.push('comment'); return detailed('comment'); };
    bili.autolikeDetailed = async () => { calls.push('like'); return detailed('like'); };
    bili.autoRelayDetailed = async () => {
        calls.push('relay');
        return detailed('relay', 6, { providerCode: 4126021, providerMessage: '等级不足无法发送，快去努力升级吧', reason: 'B站返回 4126021（等级不足无法发送，快去努力升级吧）' });
    };
    try {
        const first = await new Monitor(['FollowFeed', 1], taskContext).go(option({ dyid: '500000003', rid: 'rid-3' }));
        const second = await new Monitor(['FollowFeed', 1], taskContext).go(option({ dyid: '500000004', rid: 'rid-4' }));
        assert.equal(first.overallStatus, 'partial');
        assert.equal(second.overallStatus, 'partial');
        assert.equal(second.relay.status, 'failed');
        assert.match(second.relay.reason, /B站返回 4126021（等级不足无法发送，快去努力升级吧）/);
        assert.match(second.relay.reason, /本轮后续转发请求已停止/);
        assert.equal(second.relay.attempts.length, 0);
        assert.equal(second.comment.status, 'success');
        assert.equal(second.like.status, 'success');
        assert.deepEqual(calls, ['comment', 'like', 'relay', 'comment', 'like']);
    } finally {
        Object.assign(bili, originals); Object.assign(config, originalConfig);
    }
});

test('关注分组公开权限错误本轮只提交一次，后续仍关注新UP主', async () => {
    const originals = {
        sendChatWithOcrDetailed: bili.sendChatWithOcrDetailed,
        autoAttentionDetailed: bili.autoAttentionDetailed,
        movePartitionDetailed: bili.movePartitionDetailed,
        autolikeDetailed: bili.autolikeDetailed,
        autoRelayDetailed: bili.autoRelayDetailed
    };
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat, is_not_create_partition: config.is_not_create_partition };
    config.is_copy_chat = false;
    config.is_repost_then_chat = false;
    config.is_not_create_partition = false;
    const calls = [];
    const taskContext = {};
    bili.sendChatWithOcrDetailed = async () => detailed('comment');
    bili.autoAttentionDetailed = async uid => {
        calls.push(`follow:${uid}`);
        return detailed('follow', 0, { targetId: uid });
    };
    bili.movePartitionDetailed = async uid => {
        calls.push(`group:${uid}`);
        return detailed('follow_group', 1, {
            targetId: uid,
            providerCode: 22105,
            providerMessage: '请先公开关注后再添加分组',
            reason: 'B站返回 22105（请先公开关注后再添加分组）'
        });
    };
    bili.autolikeDetailed = async () => detailed('like');
    bili.autoRelayDetailed = async () => detailed('relay');
    try {
        const first = await new Monitor(['FollowFeed', 1], taskContext).go(option({ dyid: '500000005', uid: ['991'] }));
        const second = await new Monitor(['FollowFeed', 1], taskContext).go(option({ dyid: '500000006', uid: ['992'] }));
        assert.equal(first.follow.status, 'failed');
        assert.equal(second.follow.status, 'failed');
        assert.match(second.follow.reason, /B站返回 22105（请先公开关注后再添加分组）/);
        assert.match(second.follow.reason, /本轮后续关注分组请求已停止/);
        assert.equal(second.follow.attempts.filter(item => item.action === 'follow_group').length, 0);
        assert.deepEqual(calls, ['follow:991', 'group:991', 'follow:992']);
    } finally {
        Object.assign(bili, originals);
        Object.assign(config, originalConfig);
    }
});

test('永久错误短路仅作用于当前账号的本轮上下文', async () => {
    const original = bili.sendChatWithOcrDetailed;
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    config.is_copy_chat = false; config.is_repost_then_chat = false;
    const accountA = {};
    const accountB = {};
    let calls = 0;
    bili.sendChatWithOcrDetailed = async () => {
        calls += 1;
        return calls === 1
            ? detailed('comment', 13, { providerCode: -107, providerMessage: '账号未转正', reason: 'B站返回 -107（账号未转正）' })
            : detailed('comment');
    };
    try {
        await new Monitor(['FollowFeed', 1], accountA).go(option({ commentOnly: true }));
        const skipped = await new Monitor(['FollowFeed', 1], accountA).go(option({ commentOnly: true }));
        const otherAccount = await new Monitor(['FollowFeed', 1], accountB).go(option({ commentOnly: true }));
        assert.equal(skipped.comment.status, 'failed');
        assert.equal(otherAccount.comment.status, 'success');
        assert.equal(calls, 2);
    } finally {
        bili.sendChatWithOcrDetailed = original;
        Object.assign(config, originalConfig);
    }
});
