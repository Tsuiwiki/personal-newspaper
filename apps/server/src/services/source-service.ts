import type { SourceSummary, SourceType } from '@paper/shared';
import type { Db } from '../db/index.js';

export interface SourceRow {
  id: number;
  name: string;
  type: SourceType;
  url: string;
  site_url: string | null;
  enabled: number;
  poll_interval_minutes: number;
  extract_content: number;
  last_fetched_at: string | null;
  last_status: string | null;
  last_error: string | null;
  etag: string | null;
  last_modified: string | null;
}

const COLUMNS = `id, name, type, url, site_url, enabled, poll_interval_minutes, extract_content,
                 last_fetched_at, last_status, last_error, etag, last_modified`;

function articleCount(db: Db, sourceId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM articles WHERE source_id = ?').get(sourceId) as { n: number };
  return row.n;
}

export function toSummary(db: Db, row: SourceRow): SourceSummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    siteUrl: row.site_url,
    enabled: row.enabled === 1,
    pollIntervalMinutes: row.poll_interval_minutes,
    extractContent: row.extract_content === 1,
    lastFetchedAt: row.last_fetched_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    articleCount: articleCount(db, row.id),
  };
}

export function listSources(db: Db): SourceSummary[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS},
              (SELECT COUNT(*) FROM articles a WHERE a.source_id = sources.id) AS article_count
       FROM sources
       ORDER BY sources.enabled DESC, sources.name ASC`,
    )
    .all() as Array<SourceRow & { article_count: number }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    siteUrl: row.site_url,
    enabled: row.enabled === 1,
    pollIntervalMinutes: row.poll_interval_minutes,
    extractContent: row.extract_content === 1,
    lastFetchedAt: row.last_fetched_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    articleCount: row.article_count,
  }));
}

export function listEnabledSourceRows(db: Db): SourceRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM sources WHERE enabled = 1 ORDER BY id`).all() as SourceRow[];
}

export function getSourceRow(db: Db, id: number): SourceRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM sources WHERE id = ?`).get(id) as SourceRow | undefined;
  return row ?? null;
}

export function findSourceByUrl(db: Db, url: string): SourceRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM sources WHERE url = ?`).get(url) as SourceRow | undefined;
  return row ?? null;
}

export interface NewSource {
  name: string;
  type: SourceType;
  url: string;
  siteUrl: string | null;
  pollIntervalMinutes: number;
  enabled: boolean;
  extractContent?: boolean;
}

export function createSource(db: Db, source: NewSource): number {
  const result = db
    .prepare(
      `INSERT INTO sources (name, type, url, site_url, poll_interval_minutes, enabled, extract_content)
       VALUES (@name, @type, @url, @siteUrl, @pollIntervalMinutes, @enabled, @extractContent)`,
    )
    .run({
      ...source,
      enabled: source.enabled ? 1 : 0,
      extractContent: source.extractContent ? 1 : 0,
    });
  return Number(result.lastInsertRowid);
}

export interface SourcePatch {
  name?: string;
  enabled?: boolean;
  pollIntervalMinutes?: number;
  extractContent?: boolean;
}

export function updateSource(db: Db, id: number, patch: SourcePatch): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, now: new Date().toISOString() };
  if (patch.name !== undefined) {
    sets.push('name = @name');
    params.name = patch.name;
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = @enabled');
    params.enabled = patch.enabled ? 1 : 0;
  }
  if (patch.pollIntervalMinutes !== undefined) {
    sets.push('poll_interval_minutes = @pollIntervalMinutes');
    params.pollIntervalMinutes = patch.pollIntervalMinutes;
  }
  if (patch.extractContent !== undefined) {
    sets.push('extract_content = @extractContent');
    params.extractContent = patch.extractContent ? 1 : 0;
  }
  if (sets.length === 0) return false;
  const result = db
    .prepare(`UPDATE sources SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`)
    .run(params);
  return result.changes > 0;
}

/** 只删来源配置；文章按外键 ON DELETE SET NULL 保留在库里 */
export function deleteSource(db: Db, id: number): { keptArticles: number } | null {
  const row = getSourceRow(db, id);
  if (!row) return null;
  const kept = articleCount(db, id);
  db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  return { keptArticles: kept };
}

export interface FetchOutcomeUpdate {
  status: 'ok' | 'error';
  error: string | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string;
}

export function recordFetchOutcome(db: Db, id: number, outcome: FetchOutcomeUpdate): void {
  db.prepare(
    `UPDATE sources
     SET last_fetched_at = @fetchedAt, last_status = @status, last_error = @error,
         etag = @etag, last_modified = @lastModified, updated_at = @fetchedAt
     WHERE id = @id`,
  ).run({ ...outcome, id });
}
