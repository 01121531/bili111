const { getAiContent, getRandomOne, log } = require('../utils');

const MAX_RELAY_LENGTH = 233;

function normalizeRelayText(value) {
    return String(value || '')
        .replace(/```[\s\S]*?```/g, '')
        .trim();
}

function getSensitiveWords() {
    try {
        const words = JSON.parse(process.env.AI_SENSITIVE_WORDS || '[]');
        return Array.isArray(words) ? words.map(word => String(word || '').trim()).filter(Boolean) : [];
    } catch (_) {
        return [];
    }
}

function containsSensitiveWord(text, words = getSensitiveWords()) {
    const normalized = normalizeRelayText(text).normalize('NFKC');
    return words.some(word => normalized.includes(String(word).normalize('NFKC')));
}

function inspectRelayText(value, words = getSensitiveWords()) {
    const text = normalizeRelayText(value);
    if (!text) return { text: '', empty: true, unsafe: false };
    if (text.length > MAX_RELAY_LENGTH) return { text: '', empty: false, unsafe: true, reason: '内容超过 233 字' };
    if (containsSensitiveWord(text, words)) return { text: '', empty: false, unsafe: true, reason: '内容包含敏感词' };
    return { text, empty: false, unsafe: false };
}

function configuredRelay(runtimeConfig) {
    const relays = Array.isArray(runtimeConfig?.relay) ? runtimeConfig.relay : [];
    return normalizeRelayText(getRandomOne(relays) || '分享视频').replace(/\$\{uname\}/g, '');
}

function relayFallback(runtimeConfig, words, aiWasUnsafe = false) {
    if (process.env.AI_ALLOW_EMPTY_RELAY) return { text: '', source: 'empty', aiAttempted: true };
    const fallback = inspectRelayText(process.env.AI_FALLBACK_RELAY, words);
    if (fallback.text) return { text: fallback.text, source: aiWasUnsafe ? 'safety_fallback' : 'fallback', aiAttempted: true };
    const configured = inspectRelayText(configuredRelay(runtimeConfig), words);
    if (configured.text) return { text: configured.text, source: aiWasUnsafe || fallback.unsafe || configured.unsafe ? 'safety_fallback' : 'configured', aiAttempted: true };
    return { text: '', source: aiWasUnsafe || fallback.unsafe || configured.unsafe ? 'safety_fallback' : 'empty', aiAttempted: true };
}

function renderPrompt(template, variables) {
    return String(template || '').replace(/\{(dynamic_text|author|lottery_conditions|draw_time|account_name|video_id|video_uid)\}/g, (_, key) => variables[key] || '');
}

async function buildRelayText(options = {}) {
    const runtimeConfig = options.config || {};
    const words = getSensitiveWords();
    const videoId = String(options.videoId || '');
    const videoUid = String(options.videoUid || '');
    const fixed = inspectRelayText(configuredRelay(runtimeConfig), words);
    const aiEnabled = Boolean(process.env.ENABLE_AI_RELAY && runtimeConfig.ai_relay_parm);
    const canUseAi = typeof options.canUseAi === 'function' ? options.canUseAi : () => true;
    if (!aiEnabled) {
        return { text: fixed.text, source: fixed.unsafe ? 'safety_fallback' : fixed.text ? 'configured' : 'empty', aiAttempted: false };
    }
    if (!canUseAi()) {
        return relayFallback(runtimeConfig, words, false);
    }

    const getAi = options.getAiContent || getAiContent;
    const videoContext = `B站推荐视频 av${videoId}，UP主 UID ${videoUid}。请生成一句自然的视频转发附言。`;
    try {
        const generated = await getAi(
            runtimeConfig.ai_relay_parm.url,
            runtimeConfig.ai_relay_parm.body,
            renderPrompt(runtimeConfig.ai_relay_parm.prompt, {
                dynamic_text: videoContext,
                author: videoUid,
                lottery_conditions: '',
                draw_time: '',
                account_name: options.accountName || process.env.NOTE || '',
                video_id: videoId,
                video_uid: videoUid
            }),
            videoContext
        );
        const inspected = inspectRelayText(generated, words);
        if (inspected.text) return { text: inspected.text, source: 'ai', aiAttempted: true };
        log.warn('视频分享', `AI 附言${inspected.reason || '为空'}，使用备用文案`);
        return relayFallback(runtimeConfig, words, inspected.unsafe);
    } catch (error) {
        const message = String(error instanceof Error ? error.message : error || '')
            .replace(/(SESSDATA|bili_jct|DedeUserID|buvid3)=[^;\s]+/gi, '$1=••••••')
            .replace(/Bearer\s+\S+/gi, 'Bearer ••••••')
            .slice(0, 300);
        log.warn('视频分享', `AI 附言生成失败，使用备用文案${message ? `：${message}` : ''}`);
        return relayFallback(runtimeConfig, words, false);
    }
}

module.exports = {
    MAX_RELAY_LENGTH,
    buildRelayText,
    containsSensitiveWord,
    inspectRelayText,
    normalizeRelayText,
    renderPrompt
};
