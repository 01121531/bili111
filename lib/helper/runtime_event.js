const PREFIX = '[LOTTERY_WEB_EVENT]';

function emitRuntimeEvent(type, payload = {}) {
    if (!process.env.WEB_MANAGED_NOTIFICATIONS) return false;
    process.stdout.write(`${PREFIX}${JSON.stringify({ type, ...payload })}\n`);
    return true;
}

module.exports = { PREFIX, emitRuntimeEvent };
