import type { FastifyInstance } from 'fastify';
import { settingsUpdateSchema } from '@paper/shared';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import type { SchedulerLike } from '../services/job-service.js';
import { getSchedule, updateSchedule } from '../services/settings-service.js';
import { parseInput } from './input.js';

export function registerSettingsRoutes(
  app: FastifyInstance,
  db: Db,
  scheduler?: SchedulerLike | null,
): void {
  app.get('/api/settings', async () => ({
    schedule: getSchedule(db),
    serverTimeZone: config.timezone,
  }));

  app.patch('/api/settings', async (request) => {
    const body = parseInput(settingsUpdateSchema, request.body ?? {});
    const schedule = updateSchedule(db, body.schedule);
    scheduler?.syncPlan?.();
    return { schedule, serverTimeZone: config.timezone };
  });
}
