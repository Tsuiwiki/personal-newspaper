import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { applyMigrations, pendingMigrations, type Db } from './migrator.js';

export type { Db };

const log = logger.child('db');

export interface OpenDatabaseOptions {
  databasePath?: string;
  backupDir?: string;
  runMigrations?: boolean;
}

function hasUserTables(db: Db): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
    )
    .get() as { n: number };
  return row.n > 0;
}

function backupFileName(): string {
  return `newspaper-pre-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
}

async function backupBeforeMigrate(db: Db, databasePath: string, backupDir: string): Promise<string | null> {
  if (!fs.existsSync(databasePath) || !hasUserTables(db)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, backupFileName());
  await db.backup(target);
  log.info('升级前已备份数据库', { target });
  return target;
}

export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<Db> {
  const databasePath = options.databasePath ?? config.databasePath;
  const backupDir = options.backupDir ?? config.backupDir;

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new BetterSqlite3(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (options.runMigrations !== false) {
    const pending = pendingMigrations(db);
    if (pending.length > 0) {
      if (hasUserTables(db)) await backupBeforeMigrate(db, databasePath, backupDir);
      const applied = applyMigrations(db);
      log.info('已应用数据库迁移', { applied });
    }
  }

  return db;
}

export function tableCount(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}
