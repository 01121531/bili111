function extractJsonObject(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;

    const parseObject = candidate => {
        try {
            const parsed = JSON.parse(candidate);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    };

    const direct = parseObject(text);
    if (direct) return direct;

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        const fencedObject = parseObject(fenced[1].trim());
        if (fencedObject) return fencedObject;
    }

    for (let start = 0; start < text.length; start += 1) {
        if (text[start] !== '{') continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let end = start; end < text.length; end += 1) {
            const char = text[end];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') inString = true;
            else if (char === '{') depth += 1;
            else if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    const parsed = parseObject(text.slice(start, end + 1));
                    if (parsed) return parsed;
                    break;
                }
            }
        }
    }
    return null;
}

const STRICT_JSON_RETRY_PROMPT = '上一次返回不是可解析的 JSON 对象。请重新判断，只返回一个完整、有效的 JSON 对象，不要使用 Markdown 代码块，不要添加解释或任何前后文字；字段必须与上述要求完全一致。';

async function requestJsonObject(request, maxAttempts = 2) {
    const attemptsLimit = Math.max(1, Math.min(2, Number(maxAttempts) || 1));
    for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
        let content = null;
        try {
            content = await request({ attempt, strict: attempt > 1 });
        } catch (_) {
            content = null;
        }
        const value = extractJsonObject(content);
        if (value) return { value, attempts: attempt, retried: attempt > 1 };
    }
    return { value: null, attempts: attemptsLimit, retried: attemptsLimit > 1 };
}

module.exports = { extractJsonObject, requestJsonObject, STRICT_JSON_RETRY_PROMPT };
