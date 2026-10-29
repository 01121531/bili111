const config = require('../data/config');
const bili = require('../net/bili');
const utils = require('../utils');
const { isRateLimited, isAccountShareBlocked } = require('./video_share');

/**
 * 随机动态
 * @param {number} num
 * @returns
 */
async function randomDynamic(num) {
    let dynamics = [];
    const
        { create_dy_type, dy_contents, random_dynamic_wait } = config,
        hasShareVideo = create_dy_type === -1 || create_dy_type === 1,
        hasRandomCreate = create_dy_type === -1 || create_dy_type === 0 || typeof create_dy_type === 'undefined';
    const target = Math.max(0, Math.floor(Number(num) || 0));
    if (!target) return;

    if (hasShareVideo) {
        const seen = new Set();
        const maxRecommendationCalls = 5;
        for (let calls = 0; calls < maxRecommendationCalls && dynamics.length < target; calls += 1) {
            let recommendations;
            try {
                recommendations = await bili.getTopRcmd();
            } catch (_) {
                continue;
            }
            if (!Array.isArray(recommendations) || recommendations.length === 0) break;
            for (const item of recommendations) {
                if (!Array.isArray(item) || item.length < 2) continue;
                const uid = Number(item[0]);
                const aid = Number(item[1]);
                if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(aid) || aid <= 0 || seen.has(aid)) continue;
                seen.add(aid);
                dynamics.push([uid, aid]);
                if (dynamics.length >= target) break;
            }
        }
    }

    if (hasRandomCreate) {
        for (let index = 0; index < target; index++) {
            dynamics.push(utils.getRandomOne(dy_contents));
        }
    }

    await utils.try_for_each(
        utils.shuffle(dynamics).slice(0, target),
        async (dynamic) => {
            await utils.delay(random_dynamic_wait);
            if (dynamic instanceof Array && dynamic.length === 2 && typeof dynamic[0] === 'number') {
                const result = typeof bili.shareVideoDetailed === 'function'
                    ? await bili.shareVideoDetailed(...dynamic)
                    : { status: await bili.shareVideo(...dynamic) ? 'failed' : 'success' };
                if (result.status === 'success') {
                    utils.log.info('视频分享', `成功分享视频(av${dynamic[1]})`);
                } else if (result.status === 'skipped') {
                    utils.log.warn('视频分享', `跳过视频 av${dynamic[1]}：${result.reason || '该视频当前不可分享'}`);
                } else {
                    utils.log.error('视频分享', `分享 av${dynamic[1]} 失败：${result.reason || '未知错误'}`);
                }
                if (isRateLimited(result) || isAccountShareBlocked(result)) {
                    utils.log.warn('视频分享', `已停止本轮后续旧版视频分享：${result.reason || result.providerMessage || '账号受限或触发限流'}`);
                    return true;
                }
            } else {
                await bili.createDynamic(dynamic);
            }
            return false;
        }
    );
}

module.exports = { randomDynamic };
