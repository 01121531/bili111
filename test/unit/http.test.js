const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { send } = require('../../lib/net/http');

function request(url, options = {}) {
    return new Promise(resolve => {
        send({
            url,
            ...options,
            success: response => resolve({ ok: true, response }),
            failure: (error, detail) => resolve({ ok: false, error, detail })
        });
    });
}

async function withServer(handler, run) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('HTTP 404 和 412 不重试', async t => {
    for (const statusCode of [404, 412]) {
        await t.test(String(statusCode), async () => {
            let calls = 0;
            await withServer((_, response) => {
                calls += 1;
                response.writeHead(statusCode, { 'content-type': 'text/html' });
                response.end('<html>request blocked</html>');
            }, async url => {
                const result = await request(url);
                assert.equal(result.ok, false);
                assert.match(result.error, new RegExp(`HTTP状态码:${statusCode}`));
                assert.equal(result.detail.errorType, 'http');
                assert.equal(result.detail.httpStatus, statusCode);
                assert.match(result.detail.body, /request blocked/);
            });
            assert.equal(calls, 1);
        });
    }
});

test('GET 对 429 和 5xx 执行有限重试', async t => {
    for (const statusCode of [429, 503]) {
        await t.test(String(statusCode), async () => {
            let calls = 0;
            await withServer((_, response) => {
                calls += 1;
                response.writeHead(statusCode);
                response.end('temporary');
            }, async url => {
                const result = await request(url, { config: { wait: 1, retry_times: 2 } });
                assert.equal(result.ok, false);
            });
            assert.equal(calls, 3);
        });
    }
});

test('POST 默认不自动重试', async () => {
    let calls = 0;
    await withServer((_, response) => {
        calls += 1;
        response.writeHead(503);
        response.end('temporary');
    }, async url => {
        const result = await request(url, { method: 'POST', config: { wait: 1, retry_times: 2 } });
        assert.equal(result.ok, false);
    });
    assert.equal(calls, 1);
});

test('表单编码会规范化非法 Unicode，避免 URI malformed', async () => {
    await withServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            assert.equal(body, 'content=bad%EF%BF%BD');
            response.end('ok');
        });
    }, async url => {
        const result = await request(url, {
            method: 'POST',
            contents: { content: 'bad\uD800' },
            config: { retry: false }
        });
        assert.equal(result.ok, true);
    });
});

test('网络拒绝和请求超时返回可诊断类型', async () => {
    const refused = await request('http://127.0.0.1:9', { config: { retry: false, timeout: 50 } });
    assert.equal(refused.ok, false);
    assert.equal(refused.detail.errorType, 'network');
    assert.ok(refused.detail.transportCode);

    await withServer(() => {}, async url => {
        const timedOut = await request(url, { config: { retry: false, timeout: 20 } });
        assert.equal(timedOut.ok, false);
        assert.equal(timedOut.detail.errorType, 'timeout');
    });
});
