const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const dStorage = require('../../lib/helper/d_storage');

async function writeDyid(scope, dyid) {
    process.env.LOTTERY_ACCOUNT_SCOPE = String(scope);
    await dStorage.updateDyid(dyid);
}

test('本地 dyid 去重按当前账号隔离', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lottery-account-scope-'));
    const previousDir = process.env.LOTTERY_DYIDS_DIR;
    const previousScope = process.env.LOTTERY_ACCOUNT_SCOPE;
    try {
        process.env.LOTTERY_DYIDS_DIR = directory;
        await writeDyid(1, '900000001');
        assert.equal(await (process.env.LOTTERY_ACCOUNT_SCOPE = '1', dStorage.searchDyid('900000001')), true);
        assert.equal(await (process.env.LOTTERY_ACCOUNT_SCOPE = '2', dStorage.searchDyid('900000001')), false);
        await writeDyid(2, '900000001');
        assert.equal(await (process.env.LOTTERY_ACCOUNT_SCOPE = '2', dStorage.searchDyid('900000001')), true);
        assert.equal(await (process.env.LOTTERY_ACCOUNT_SCOPE = '1', dStorage.searchDyid('900000001')), true);
    } finally {
        if (previousDir === undefined) delete process.env.LOTTERY_DYIDS_DIR; else process.env.LOTTERY_DYIDS_DIR = previousDir;
        if (previousScope === undefined) delete process.env.LOTTERY_ACCOUNT_SCOPE; else process.env.LOTTERY_ACCOUNT_SCOPE = previousScope;
        rmSync(directory, { recursive: true, force: true });
    }
});
