import type { FastifyInstance } from 'fastify';
import { idParamSchema, issueGenerateSchema, issuePreviewSchema } from '@paper/shared';
import type { Db } from '../db/index.js';
import { notFound } from '../errors.js';
import { buildIssuePreview, generateIssue, publishIssue } from '../services/issue-builder.js';
import { getIssueRow, getLatestIssue, listIssues, toIssueView } from '../services/issue-service.js';
import { getSchedule } from '../services/settings-service.js';
import { parseInput } from './input.js';

export function registerIssueRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/issues/latest', async () => getLatestIssue(db));

  app.get('/api/issues', async () => ({ items: listIssues(db) }));

  app.post('/api/issues/preview', async (request) => {
    const input = parseInput(issuePreviewSchema, request.body ?? {});
    return buildIssuePreview(db, { ...input, timeZone: getSchedule(db).timeZone });
  });

  app.post('/api/issues/generate', async (request, reply) => {
    const input = parseInput(issueGenerateSchema, request.body ?? {});
    const result = generateIssue(db, { ...input, timeZone: getSchedule(db).timeZone });
    if (result.generated && !result.replacedDraft) {
      return reply.code(201).send(result);
    }
    return result;
  });

  app.post('/api/issues/:id/publish', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    return publishIssue(db, id);
  });

  app.get('/api/issues/:id', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const row = getIssueRow(db, id);
    if (!row) throw notFound('这一期期刊不存在');
    return toIssueView(db, row);
  });
}
