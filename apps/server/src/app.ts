import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { GuardError } from './security/url-guard.js';
import type { Db } from './db/index.js';
import { ApiError } from './errors.js';
import { logger } from './logger.js';
import { registerRequestGuard } from './security/request-guard.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerIssueRoutes } from './routes/issues.js';
import { registerArticleRoutes } from './routes/articles.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerBackupRoutes } from './routes/backups.js';
import type { SchedulerLike } from './services/job-service.js';
import type { CollectorOptions } from './ingestion/fetch-source.js';

const log = logger.child('http');

export interface AppOptions {
  /** 采集器的可替换依赖：测试里注入假 fetch 与放行本地地址的策略 */
  collector?: CollectorOptions;
  /** 定时器实例，仅用于查询状态；测试里可以不传 */
  scheduler?: SchedulerLike | null;
  /** 备份目录；测试用临时目录，避免写进仓库 */
  backupDir?: string;
}

export function buildApp(db: Db, options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  });

  registerRequestGuard(app);

  app.addHook('onResponse', async (request, reply) => {
    log.info(`${request.method} ${request.url.split('?')[0]}`, {
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  registerHealthRoutes(app);
  registerIssueRoutes(app, db);
  registerArticleRoutes(app, db, options.collector ?? {});
  registerSourceRoutes(app, db, options.collector);
  registerTemplateRoutes(app, db);
  registerSettingsRoutes(app, db, options.scheduler);
  registerJobRoutes(app, db, options.collector, options.scheduler);
  registerBackupRoutes(app, db, options.backupDir ?? config.backupDir);

  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404).send({
      error: { code: 'E_NOT_FOUND', message: `没有这个接口：${request.method} ${request.url.split('?')[0]}` },
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    if (error instanceof GuardError) {
      return reply.code(400).send({ error: { code: error.code, message: error.message } });
    }
    if ((error as { statusCode?: number }).statusCode === 415) {
      return reply.code(415).send({
        error: { code: 'E_UNSUPPORTED_MEDIA_TYPE', message: '请求体需要是 JSON（Content-Type: application/json）' },
      });
    }
    log.error('未处理的服务端错误', {
      method: request.method,
      url: request.url.split('?')[0],
      error,
    });
    return reply.code(500).send({
      error: { code: 'E_INTERNAL', message: '服务端出错了，请查看日志后重试' },
    });
  });

  return app;
}
