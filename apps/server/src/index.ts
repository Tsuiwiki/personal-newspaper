import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { buildApp } from './app.js';
import { logger } from './logger.js';
import { Scheduler } from './scheduler.js';

const log = logger.child('boot');

async function main(): Promise<void> {
  const db = await openDatabase();
  const scheduler = new Scheduler({ db });
  const app = buildApp(db, { scheduler });

  const shutdown = async (signal: string) => {
    log.info('收到退出信号，正在关闭', { signal });
    await scheduler.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  scheduler.start();

  if (!config.loopbackOnly) {
    log.warn('服务未绑定回环地址：对外暴露前请配置认证、HTTPS 与防火墙', { host: config.host });
  }
  log.info('服务已启动', {
    url: `http://${config.host}:${config.port}`,
    database: config.databasePath,
    timezone: config.timezone,
  });
}

main().catch((error) => {
  log.error('启动失败', { error });
  process.exit(1);
});
