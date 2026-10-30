import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';

export type Db = BetterSqlite3.Database;

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface Migration {
  id: string;
  sql: string;
}

export function loadMigrations(dir = migrationsDir): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({
      id: file.replace(/\.sql$/, ''),
      sql: fs.readFileSync(path.join(dir, file), 'utf8'),
    }));
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

export function pendingMigrations(db: Db, migrations = loadMigrations()): Migration[] {
  ensureMigrationsTable(db);
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => (row as { id: string }).id));
  return migrations.filter((migration) => !applied.has(migration.id));
}

/** 每个迁移单独一个事务：失败即回滚，数据库不会停在半迁移状态 */
export function applyMigrations(db: Db, migrations = loadMigrations()): string[] {
  const pending = pendingMigrations(db, migrations);
  const record = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  const applied: string[] = [];
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id);
    })();
    applied.push(migration.id);
  }
  return applied;
}
