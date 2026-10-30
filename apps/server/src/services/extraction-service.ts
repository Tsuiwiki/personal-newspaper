import type { ArticleDetail, ContentAccessLevel, ExtractionResult } from '@paper/shared';
import type { Db } from '../db/index.js';
import { ApiError } from '../errors.js';
import {
  ExtractError,
  describeExtractError,
  extractArticleBody,
  type ExtractorDeps,
} from '../extraction/content-extractor.js';
import { logger } from '../logger.js';
import { getArticleDetail } from './article-service.js';

const log = logger.child('extract');

/** 一次采集最多自动读几篇原文，避免刚加来源就把整站扫一遍 */
export const AUTO_EXTRACT_PER_FETCH = 3;

interface TargetRow {
  id: number;
  url: string;
  title: string;
  content_access_level: ContentAccessLevel;
}

function contentTarget(db: Db, id: number): TargetRow | null {
  const row = db
    .prepare(
      `SELECT id, COALESCE(canonical_url, original_url) AS url, title, content_access_level
       FROM articles WHERE id = ?`,
    )
    .get(id) as TargetRow | undefined;
  return row ?? null;
}

function conflictResult(article: ArticleDetail): ExtractionResult {
  return {
    ok: false,
    article,
    characters: 0,
    truncated: false,
    usedFallback: false,
    error: { code: 'E_CONTENT_USER_PROVIDED', message: '正文由你提供，提取不会覆盖它' },
  };
}

/**
 * 提取单篇文章的公开正文。
 * 成功写入 content_text 并标记 extracted；失败只记原因，保留原有标题、摘要、链接和已存正文。
 * 用户自己提供的正文永远不会被覆盖。
 */
export async function extractArticleContent(
  db: Db,
  id: number,
  deps: ExtractorDeps = {},
): Promise<ExtractionResult | null> {
  const target = contentTarget(db, id);
  if (!target) return null;

  const before = getArticleDetail(db, id);
  if (!before) return null;
  if (target.content_access_level === 'user_provided') return conflictResult(before);

  try {
    const extracted = await extractArticleBody(target.url, { ...deps, title: target.title });
    const now = new Date().toISOString();
    const updated = db
      .prepare(
        `UPDATE articles
         SET content_text = @text, content_access_level = 'extracted',
             content_html_sanitized = NULL, extracted_at = @now, extract_error = NULL, updated_at = @now
         WHERE id = @id AND content_access_level <> 'user_provided'`,
      )
      .run({ id, text: extracted.text, now });

    if (updated.changes === 0) {
      const current = getArticleDetail(db, id);
      if (!current) return null;
      return conflictResult(current);
    }

    const article = getArticleDetail(db, id);
    if (!article) return null;
    return {
      ok: true,
      article,
      characters: extracted.characters,
      truncated: extracted.truncated,
      usedFallback: extracted.usedFallback,
      error: null,
    };
  } catch (cause) {
    const message = describeExtractError(cause);
    const code = cause instanceof ExtractError ? cause.code : 'E_EXTRACT_FAILED';
    db.prepare(
      `UPDATE articles SET extract_error = ?, updated_at = ?
       WHERE id = ? AND content_access_level <> 'user_provided'`,
    ).run(message, new Date().toISOString(), id);

    const article = getArticleDetail(db, id);
    if (!article) return null;
    log.info('正文提取未成功', { articleId: id, code, message });
    return {
      ok: false,
      article,
      characters: 0,
      truncated: false,
      usedFallback: false,
      error: { code, message },
    };
  }
}

/** 用户粘贴自己有权使用的正文；会替换现有正文并标记来源，之后提取不再覆盖 */
export function saveManualContent(db: Db, id: number, content: string): ArticleDetail | null {
  const exists = db.prepare('SELECT 1 AS ok FROM articles WHERE id = ?').get(id);
  if (!exists) return null;

  const text = content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.replace(/\s+/g, '').length < 20) {
    throw new ApiError(400, 'E_VALIDATION', '正文至少需要 20 个字符');
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE articles
     SET content_text = @text, content_access_level = 'user_provided',
         content_html_sanitized = NULL, extracted_at = NULL, extract_error = NULL, updated_at = @now
     WHERE id = @id`,
  ).run({ id, text, now });

  return getArticleDetail(db, id);
}

/** 采集结束后，对本次新入库、且来源开启了提取的文章补正文；单篇失败不影响其它篇 */
export async function autoExtractNewArticles(
  db: Db,
  sourceId: number,
  afterArticleId: number,
  deps: ExtractorDeps = {},
  limit = AUTO_EXTRACT_PER_FETCH,
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT id FROM articles
       WHERE source_id = @sourceId AND id > @afterId AND content_text IS NULL
         AND content_access_level IN ('link_only', 'metadata')
       ORDER BY id
       LIMIT @limit`,
    )
    .all({ sourceId, afterId: afterArticleId, limit }) as Array<{ id: number }>;

  let extracted = 0;
  for (const row of rows) {
    try {
      const result = await extractArticleContent(db, row.id, deps);
      if (result?.ok) extracted += 1;
    } catch (cause) {
      log.warn('自动提取正文时出错', { articleId: row.id, error: describeExtractError(cause) });
    }
  }
  return extracted;
}
