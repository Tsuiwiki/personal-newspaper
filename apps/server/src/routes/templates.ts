import type { FastifyInstance } from 'fastify';
import { idParamSchema, templateCreateSchema, templatePatchSchema } from '@paper/shared';
import type { Db } from '../db/index.js';
import {
  copyTemplate,
  createTemplate,
  listTemplates,
  setDefaultTemplate,
  updateTemplate,
} from '../services/template-service.js';
import { parseInput } from './input.js';

export function registerTemplateRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/templates', async () => ({ items: listTemplates(db) }));

  app.post('/api/templates', async (request, reply) => {
    const input = parseInput(templateCreateSchema, request.body ?? {});
    const template = createTemplate(db, input);
    return reply.code(201).send(template);
  });

  app.post('/api/templates/:id/copy', async (request, reply) => {
    const { id } = parseInput(idParamSchema, request.params);
    return reply.code(201).send(copyTemplate(db, id));
  });

  app.patch('/api/templates/:id', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const patch = parseInput(templatePatchSchema, request.body ?? {});
    return updateTemplate(db, id, patch);
  });

  app.post('/api/templates/:id/default', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    return setDefaultTemplate(db, id);
  });
}
