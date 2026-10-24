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

module.exports = { extractJsonObject };
