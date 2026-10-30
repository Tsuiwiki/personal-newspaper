import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    time: new Date().toISOString(),
  }));
}
