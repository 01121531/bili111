'use strict';

/**
 * Parse a clearly labelled draw/deadline date from public lottery text.
 * The returned timestamp is Unix seconds in Asia/Shanghai.
 */
function parseDrawTime(text, sourceCreatedAt) {
    const value = String(text || '');
    const match = value.match(/(?:开奖(?:时间)?|截至|截止)[^\d]{0,10}(?:(\d{4})[年./-])?(\d{1,2})[月./-](\d{1,2})日?(?:\s*(\d{1,2})(?:[:点时](\d{1,2})?)?)?/i)
        || value.match(/(?:(\d{4})[年./-])?(\d{1,2})[月./-](\d{1,2})日?(?:\s*(\d{1,2})(?:[:点时](\d{1,2})?)?)?[^，。\n]{0,10}(?:开奖|开抽|抽(?:取|出|一|送)?)/i);
    if (!match) return null;
    const source = sourceCreatedAt ? new Date(Number(sourceCreatedAt) * 1000) : new Date();
    let year = Number(match[1] || source.getFullYear());
    const month = Number(match[2]); const day = Number(match[3]);
    const hour = Number(match[4] || 0); const minute = Number(match[5] || 0);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    let timestamp = Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;
    if (!match[1] && sourceCreatedAt && timestamp < Number(sourceCreatedAt) - 30 * 86400) {
        year += 1;
        timestamp = Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;
    }
    const check = new Date((timestamp + 8 * 3600) * 1000);
    return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day ? timestamp : null;
}

function normalizeAiDrawTime(value, now = Date.now() / 1000) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const seconds = numeric > 1e12 ? numeric / 1000 : numeric;
    if (seconds < 946684800 || seconds > now + 10 * 365 * 86400) return null;
    return Math.round(seconds);
}

module.exports = { parseDrawTime, normalizeAiDrawTime };
