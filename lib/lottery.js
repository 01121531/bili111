const utils = require('./utils');
const event_bus = require('./helper/event_bus');
const global_var = require('./data/global_var');
const { Searcher } = require('./core/searcher');
const { Monitor } = require('./core/monitor');
const config = require('./data/config');
const { randomDynamic } = require('./helper/randomDynamic');
const { sendNotify } = require('./helper/notify');
const { log } = utils;

async function createRandomDynamic(num) {
    if (config.create_dy) {
        log.info('随机动态', `准备创建${num}条随机动态`);
        const
            { allModifyDynamicResArray } = (await utils.retryfn(
                3,
                [null],
                () => Searcher.checkAllDynamic(global_var.get('myUID'), 1)
            )) || { allModifyDynamicResArray: [] },
            { type, origin_type } = allModifyDynamicResArray[0] || {};
        if (type === 1 && origin_type !== 8) {
            await randomDynamic(num);
        } else {
            log.info('随机动态', '已有非抽奖动态故无需创建');
        }
    }
}

/**
 * 抽奖主函数
 * @param {string} num
 * @returns {Promise<void>}
 */
function start(num) {
    return new Promise((resolve, reject) => {
        let times = utils.counter();
        let settled = false;
        const taskContext = {};

        const finish = async reason => {
            if (settled) return;
            settled = true;
            let fatalError = reason instanceof Error ? reason : null;
            const message = fatalError ? fatalError.message : reason;
            log.info('结束抽奖', '原因: ' + message);
            if (config.notice_running_state) {
                try {
                    await sendNotify(
                        `动态抽奖-帐号${num}结束抽奖`,
                        `${log._cache.filter(it => /抽奖\]|Error|\s抽奖信息\]/.test(it)).join('\n')}`
                    );
                } catch (error) {
                    log.warn('运行状态通知', `发送失败: ${error.message}`);
                }
            }
            if (!fatalError) {
                try {
                    await createRandomDynamic(config.create_dy_num);
                } catch (error) {
                    fatalError = error;
                }
            }
            event_bus.flush();
            if (fatalError) reject(fatalError);
            else resolve();
        };

        /* 注册事件 */
        event_bus.on('Turn_on_the_Monitor', async () => {
            try {
                const lotterys = global_var.get('Lottery');
                if (lotterys.length === 0) {
                    event_bus.emit('Turn_off_the_Monitor', new Error('未配置任何抽奖来源，请启用关注动态流或配置其他来源'));
                    return;
                }
                if (times.value() === lotterys.length) {
                    log.info('抽奖', '所有动态转发完毕');
                    times.clear();
                    event_bus.emit('Turn_off_the_Monitor', utils.hasEnv('NOT_GO_LOTTERY')
                        ? '本轮扫描成功，未发现更多符合条件的抽奖'
                        : '本轮扫描完成，未发现更多符合条件的抽奖');
                    return;
                }
                const lottery = lotterys[times.next()];

                await (new Monitor(lottery, taskContext)).init();
            } catch (error) {
                event_bus.emit('Turn_off_the_Monitor', error instanceof Error ? error : new Error(String(error)));
            }
        });
        event_bus.on('Turn_off_the_Monitor', reason => {
            finish(reason).catch(error => {
                event_bus.flush();
                reject(error);
            });
        });
        event_bus.emit('Turn_on_the_Monitor');
    });
}


module.exports = { start };
