import fs from 'node:fs';
import path from 'node:path';
import type { BackupFile } from '@paper/shared';
import type { Db } from '../db/index.js';

const BACKUP_PATTERN = /^newspaper-(backup|pre-migration)-[\w.-]+\.db$/;

export async function createBackup(db: Db, dir: string, now = new Date()): Promise<BackupFile> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const name = `newspaper-backup-${stamp}.db`;
  const target = path.join(dir, name);
  await db.backup(target);
  const stat = fs.statSync(target);
  return {
    file: name,
    bytes: stat.size,
    createdAt: stat.mtime.toISOString(),
    kind: 'manual',
  };
}

export function listBackups(dir: string): BackupFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => BACKUP_PATTERN.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return {
        file: name,
        bytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        kind: name.includes('pre-migration') ? ('pre-migration' as const) : ('manual' as const),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
