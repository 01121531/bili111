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

test('参与动作返回实际评论、转发文案和来源', async () => {
    const originals = { sendChatWithOcr: bili.sendChatWithOcr, autolike: bili.autolike, autoRelay: bili.autoRelay };
    const originalConfig = { check_if_duplicated: config.check_if_duplicated, is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    let commentCalls = 0; let relayedText = '';
    config.check_if_duplicated = 3; config.is_copy_chat = false; config.is_repost_then_chat = false;
    globalVar.set('myUID', '701');
    bili.sendChatWithOcr = async () => { commentCalls += 1; return commentCalls === 1 ? 8 : 0; };
    bili.autolike = async () => 0;
    bili.autoRelay = async (_uid, _dyid, text) => { relayedText = text; return 0; };
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
    const originals = { sendChatWithOcr: bili.sendChatWithOcr, autolike: bili.autolike, autoRelay: bili.autoRelay };
    const originalConfig = { check_if_duplicated: config.check_if_duplicated, is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat };
    config.check_if_duplicated = 3; config.is_copy_chat = false; config.is_repost_then_chat = false;
    bili.sendChatWithOcr = async () => 0;
    bili.autolike = async () => 2;
    bili.autoRelay = async () => 0;
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
    const originals = { sendChatWithOcr: bili.sendChatWithOcr, autoAttention: bili.autoAttention, autolike: bili.autolike, autoRelay: bili.autoRelay };
    const originalConfig = { is_copy_chat: config.is_copy_chat, is_repost_then_chat: config.is_repost_then_chat, is_not_create_partition: config.is_not_create_partition };
    config.is_copy_chat = false; config.is_repost_then_chat = false; config.is_not_create_partition = true;
    const calls = [];
    bili.sendChatWithOcr = async () => { calls.push('comment'); return 0; };
    bili.autoAttention = async () => { calls.push('follow'); return 2; };
    bili.autolike = async () => { calls.push('like'); return 0; };
    bili.autoRelay = async () => { calls.push('relay'); return 0; };
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
