import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { createBackup, listBackups } from '../services/backup-service.js';

export function registerBackupRoutes(app: FastifyInstance, db: Db, backupDir: string): void {
  app.get('/api/backups', async () => ({ dir: backupDir, items: listBackups(backupDir) }));

  app.post('/api/backups', async (_request, reply) => {
    const backup = await createBackup(db, backupDir);
    return reply.code(201).send(backup);
  });
}
