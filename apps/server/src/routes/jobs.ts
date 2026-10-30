import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobRunInputSchema } from '@paper/shared';
import type { Db } from '../db/index.js';
import { ApiError } from '../errors.js';
import type { CollectorOptions } from '../ingestion/fetch-source.js';
import { getJobStatus, listRuns, runDailyJob, type SchedulerLike } from '../services/job-service.js';
import { getSchedule } from '../services/settings-service.js';
import { todayInTimeZone } from '../time.js';
import { parseInput } from './input.js';

const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function registerJobRoutes(
  app: FastifyInstance,
  db: Db,
  collector: CollectorOptions = {},
  scheduler?: SchedulerLike | null,
): void {
  app.get('/api/jobs/status', async () => getJobStatus(db, { scheduler }));

  app.get('/api/jobs/runs', async (request) => {
    const { limit } = parseInput(runsQuerySchema, request.query);
    return { items: listRuns(db, limit) };
  });

  app.post('/api/jobs/run', async (request) => {
    const input = parseInput(jobRunInputSchema, request.body ?? {});
    const settings = getSchedule(db);
    const runDate = input.date ?? todayInTimeZone(settings.timeZone);
    const outcome = await runDailyJob(db, {
      trigger: 'manual',
      runDate,
      generate: input.generate ?? settings.autoGenerate,
      publish: input.publish ?? settings.publish,
      replaceDraft: input.replaceDraft ?? false,
      collector,
    });
    if (outcome.skipped === 'busy') {
      throw new ApiError(409, 'E_JOB_RUNNING', '已有采集任务在跑，请等它结束后再试');
    }
    return outcome.run;
  });
}
