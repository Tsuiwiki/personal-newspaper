import type {
  ArticleCard,
  ArticleDetail,
  ArticleListPage,
  ContentAccessLevel,
  ReadingStatus,
} from '@paper/shared';
import type { Db } from '../db/index.js';
import { estimateReadMinutes } from './issue-service.js';

interface ArticleRow {
  id: number;
  title: string;
  author: string | null;
  published_at: string | null;
  discovered_at: string;
  canonical_url: string | null;
  original_url: string;
  summary: string | null;
  content_text: string | null;
  content_access_level: ContentAccessLevel;
  image_url: string | null;
  source_id: number | null;
  source_name: string | null;
  reading_status: ReadingStatus | null;
  note: string | null;
  extracted_at: string | null;
  extract_error: string | null;
}

function toCard(row: ArticleRow): ArticleCard {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    sourceId: row.source_id,
    sourceName: row.source_name,
    publishedAt: row.published_at,
    summary: row.summary,
    imageUrl: row.image_url,
    originalUrl: row.original_url,
    accessLevel: row.content_access_level,
    readingStatus: row.reading_status ?? 'unread',
    hasFullText: Boolean(row.content_text),
    readMinutes: estimateReadMinutes(row.content_text, row.summary),
  };
}

const BASE_SELECT = `
  SELECT
    a.id, a.title, a.author, a.published_at, a.discovered_at, a.canonical_url, a.original_url,
    a.summary, a.content_text, a.content_access_level, a.image_url, a.extracted_at, a.extract_error,
    s.id AS source_id, s.name AS source_name,
    rs.status AS reading_status, rs.note AS note
  FROM articles a
  LEFT JOIN sources s ON s.id = a.source_id
  LEFT JOIN reading_states rs ON rs.article_id = a.id
`;

export function getArticleDetail(db: Db, id: number): ArticleDetail | null {
  const row = db.prepare(`${BASE_SELECT} WHERE a.id = ?`).get(id) as ArticleRow | undefined;
  if (!row) return null;
  return {
    ...toCard(row),
    canonicalUrl: row.canonical_url,
    discoveredAt: row.discovered_at,
    summaryIsSystem: row.content_access_level !== 'user_provided',
    contentText: row.content_text,
    note: row.note,
    extractedAt: row.extracted_at,
    extractError: row.extract_error,
  };
}

export interface ArticleListQuery {
  page: number;
  pageSize: number;
  status?: ReadingStatus;
  sourceId?: number;
  q?: string;
}

export function listArticles(db: Db, query: ArticleListQuery): ArticleListPage {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (query.status === 'unread') {
    where.push("(rs.status IS NULL OR rs.status = 'unread')");
  } else if (query.status) {
    where.push('rs.status = @status');
    params.status = query.status;
  }
  if (query.sourceId) {
    where.push('a.source_id = @sourceId');
    params.sourceId = query.sourceId;
  }
  if (query.q) {
    where.push('(a.title LIKE @q OR a.summary LIKE @q)');
    params.q = `%${query.q}%`;
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (query.page - 1) * query.pageSize;

  const rows = db
    .prepare(
      `${BASE_SELECT} ${whereSql}
       ORDER BY COALESCE(a.published_at, a.discovered_at) DESC, a.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: query.pageSize, offset }) as ArticleRow[];

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM articles a
       LEFT JOIN reading_states rs ON rs.article_id = a.id
       ${whereSql}`,
    )
    .get(params) as { n: number };

  return { items: rows.map(toCard), total: totalRow.n, page: query.page, pageSize: query.pageSize };
}

export interface ReadingStatePatch {
  status?: ReadingStatus;
  note?: string | null;
  progress?: number | null;
}

export function updateReadingState(db: Db, id: number, patch: ReadingStatePatch): ArticleDetail | null {
  const exists = db.prepare('SELECT 1 AS ok FROM articles WHERE id = ?').get(id);
  if (!exists) return null;

  const current = db
    .prepare('SELECT status, note, progress FROM reading_states WHERE article_id = ?')
    .get(id) as { status: ReadingStatus; note: string | null; progress: number | null } | undefined;

  const next = {
    article_id: id,
    status: patch.status ?? current?.status ?? 'unread',
    note: patch.note !== undefined ? patch.note : (current?.note ?? null),
    progress: patch.progress !== undefined ? patch.progress : (current?.progress ?? null),
  };

  db.prepare(
    `INSERT INTO reading_states (article_id, status, note, progress, updated_at)
     VALUES (@article_id, @status, @note, @progress, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (article_id) DO UPDATE SET
       status = excluded.status,
       note = excluded.note,
       progress = excluded.progress,
       updated_at = excluded.updated_at`,
  ).run(next);

  return getArticleDetail(db, id);
}
