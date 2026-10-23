const config = require('../data/config');
const bili = require('../net/bili');
const utils = require('../utils');

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
                await bili.shareVideo(...dynamic);
            } else {
                await bili.createDynamic(dynamic);
            }
        }
    );
}

module.exports = { randomDynamic };
