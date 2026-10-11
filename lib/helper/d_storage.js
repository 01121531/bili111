const { log, readDyidFile, writeDyidFile } = require('../utils');

function accountScope() {
    const value = process.env.LOTTERY_ACCOUNT_SCOPE || process.env.NUMBER || '1';
    return String(value).trim() || '1';
}

const d_storage = {
    /**
     * Return the stable account scope used by the current CLI child process.
     * NUMBER remains the fallback for direct CLI and legacy multi-account mode.
     */
    getAccountScope: accountScope,
    /**
     * 搜索dyid
     * @param {string} dyid
     * @returns {Promise<boolean>}
     */
    searchDyid: async (dyid) => {
        let buffer = '';
        let found = false;

        const stream = readDyidFile(Number(accountScope()));

        try {
            for await (const chunk of stream) {
                buffer += chunk;

                while ((buffer.indexOf(dyid)) !== -1) {
                    found = true;
                    stream.destroy();
                    return found;
                }

                const lastCommaIdx = buffer.lastIndexOf(',');
                if (lastCommaIdx !== -1) {
                    buffer = buffer.slice(lastCommaIdx);
                }
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') log.warn('读取dyid', `账号${accountScope()}读取记录失败: ${error.message || error}`);
            return false;
        }

        if (!found && buffer.length > 0) {
            if (buffer.includes(dyid)) {
                found = true;
            }
        }

        stream.destroy();
        return found;
    },
    /**
     * 更新dyid
     * @param {string} dyid
     */
    updateDyid: (dyid) => {
        log.info('更新dyid', `账号${accountScope()}写入${dyid}`);
        return new Promise((resolve) => {
            const ws = writeDyidFile(Number(accountScope()));
            ws.write(dyid + ',', () => {
                ws.destroy();
                resolve();
            });
            ws.on('error', err => {
                log.error('更新dyid', err);
                resolve();
            });
        });
    }
};


module.exports = d_storage;
