const bili = require('../net/bili');
const config = require('../data/config');
const { delay, log } = require('../utils');

function boundedInteger(value, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(max, Math.max(0, Math.floor(number)));
}

function validRecommendation(item) {
    if (!Array.isArray(item) || item.length < 2) return null;
    const uid = Number(item[0]);
    const aid = Number(item[1]);
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(aid) || aid <= 0) return null;
    return [uid, aid];
}

function isRateLimited(result) {
    if (!result || typeof result !== 'object') return false;
    const providerCode = Number(result.providerCode);
    const httpStatus = Number(result.httpStatus);
    if ([412, 429].includes(httpStatus)) return true;
    if ([4128002, -352, -412, -429, -509].includes(providerCode)) return true;
    return /操作太频繁|请求过于频繁|触发风控|限流/i.test(String(result.providerMessage || result.reason || ''));
}

class VideoShareController {
    constructor(options = {}) {
        this.config = options.config || config;
        this.biliClient = options.biliClient || bili;
        this.getRecommendations = options.getRecommendations || (() => this.biliClient.getTopRcmd());
        this.shareVideo = options.shareVideo || ((uid, aid) => {
            if (typeof this.biliClient.shareVideoDetailed === 'function') {
                return this.biliClient.shareVideoDetailed(uid, aid);
            }
            return this.biliClient.shareVideo(uid, aid);
        });
        this.maxRecommendationCalls = boundedInteger(options.maxRecommendationCalls ?? 5, 20) || 5;
        this.recommendationCalls = 0;
        this.candidates = [];
        this.seenVideoIds = new Set();
        this.exhausted = false;
        this.successfulForwards = 0;
        this.sharedVideoIds = [];
        this.finished = false;
        this.shareInterval = boundedInteger(options.shareInterval ?? 5000, 60000);
        this.rateLimitReason = '';
        this.lastShareAttemptAt = 0;
    }

    get everyForwards() {
        return boundedInteger(this.config.share_video_every_forwards, 100);
    }

    get countPerTrigger() {
        return boundedInteger(this.config.share_video_count_per_trigger, 20);
    }

    get countAfterRun() {
        return boundedInteger(this.config.share_video_after_run, 20);
    }

    async loadCandidates() {
        while (!this.exhausted && this.candidates.length === 0 && this.recommendationCalls < this.maxRecommendationCalls) {
            this.recommendationCalls += 1;
            let recommendations;
            try {
                recommendations = await this.getRecommendations();
            } catch (_) {
                log.warn('视频分享', '获取推荐视频失败，稍后尝试其他候选');
                continue;
            }
            if (!Array.isArray(recommendations) || recommendations.length === 0) {
                this.exhausted = true;
                break;
            }
            for (const item of recommendations) {
                const candidate = validRecommendation(item);
                if (!candidate || this.seenVideoIds.has(candidate[1])) continue;
                this.seenVideoIds.add(candidate[1]);
                this.candidates.push(candidate);
            }
        }
        if (this.recommendationCalls >= this.maxRecommendationCalls && this.candidates.length === 0) this.exhausted = true;
    }

    async shareOne() {
        if (this.rateLimitReason) return false;
        await this.loadCandidates();
        const candidate = this.candidates.shift();
        if (!candidate) return false;
        const [uid, aid] = candidate;
        const minimumWait = Math.max(this.shareInterval, Math.max(0, Number(this.config.random_dynamic_wait) || 0));
        const elapsed = this.lastShareAttemptAt ? Date.now() - this.lastShareAttemptAt : minimumWait;
        const wait = Math.max(0, minimumWait - elapsed);
        if (wait) await delay(wait);
        this.lastShareAttemptAt = Date.now();
        let result;
        try {
            result = await this.shareVideo(uid, aid);
        } catch (_) {
            log.warn('视频分享', `分享 av${aid} 失败：本地执行异常`);
            return false;
        }
        const status = result && typeof result === 'object' ? result.status : (result === false ? 'success' : 'failed');
        if (status === 'success') {
            this.sharedVideoIds.push(aid);
            return true;
        }
        if (status === 'skipped') {
            log.warn('视频分享', `跳过 av${aid}：该视频当前不可分享`);
        } else if (result && typeof result === 'object' && result.reason) {
            log.error('视频分享', `分享 av${aid} 失败：${result.reason}`);
        } else {
            log.error('视频分享', `分享 av${aid} 失败`);
        }
        if (isRateLimited(result)) {
            this.rateLimitReason = String(result.reason || result.providerMessage || 'B站视频分享触发限流');
            log.warn('视频分享', `已停止本轮后续视频分享：${this.rateLimitReason}`);
        }
        return false;
    }

    async shareBatch(count, reason) {
        const target = boundedInteger(count, 20);
        if (!target) return 0;
        if (this.rateLimitReason) {
            log.warn('视频分享', `${reason}：本轮已因限流停止，跳过后续分享`);
            return 0;
        }
        let shared = 0;
        while (shared < target && !this.rateLimitReason) {
            const success = await this.shareOne();
            if (success) shared += 1;
            else if (this.candidates.length === 0 && this.exhausted) break;
        }
        log.info('视频分享', `${reason}：目标 ${target} 个，成功 ${shared} 个`);
        return shared;
    }

    async recordSuccessfulForward() {
        this.successfulForwards += 1;
        if (!this.everyForwards || !this.countPerTrigger) return { triggered: false, successfulForwards: this.successfulForwards };
        if (this.successfulForwards % this.everyForwards !== 0) return { triggered: false, successfulForwards: this.successfulForwards };
        const shared = await this.shareBatch(this.countPerTrigger, `成功转发 ${this.successfulForwards} 条后触发`);
        return { triggered: true, shared, successfulForwards: this.successfulForwards };
    }

    async finish() {
        if (this.finished) return { shared: 0, alreadyFinished: true };
        this.finished = true;
        if (!this.countAfterRun) return { shared: 0, alreadyFinished: false };
        const shared = await this.shareBatch(this.countAfterRun, '抽奖任务结束后');
        return { shared, alreadyFinished: false };
    }
}

module.exports = { VideoShareController, boundedInteger, validRecommendation, isRateLimited };
