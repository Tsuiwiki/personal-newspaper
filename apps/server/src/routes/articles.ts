import type { FastifyInstance } from 'fastify';
import {
  articleListQuerySchema,
  idParamSchema,
  manualContentSchema,
  manualLinkSchema,
  readingStatePatchSchema,
} from '@paper/shared';
import type { Db } from '../db/index.js';
import type { ExtractorDeps } from '../extraction/content-extractor.js';
import { ApiError, notFound } from '../errors.js';
import { canonicalizeUrl, contentHash } from '../ingestion/normalize.js';
import {
  getArticleDetail,
  listArticles,
  updateReadingState,
} from '../services/article-service.js';
import { extractArticleContent, saveManualContent } from '../services/extraction-service.js';
import { parseInput } from './input.js';

export function registerArticleRoutes(app: FastifyInstance, db: Db, extractor: ExtractorDeps = {}): void {
  app.get('/api/articles', async (request) => {
    const query = parseInput(articleListQuerySchema, request.query);
    return listArticles(db, query);
  });

  app.get('/api/articles/:id', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const article = getArticleDetail(db, id);
    if (!article) throw notFound('这篇文章不在文章库里');
    return article;
  });

  app.post('/api/articles/manual-link', async (request, reply) => {
    const body = parseInput(manualLinkSchema, request.body ?? {});
    const canonicalUrl = canonicalizeUrl(body.url);
    if (!canonicalUrl) throw new ApiError(400, 'E_URL_INVALID', '这个链接无法规范化，请检查地址');

    const existing = db.prepare('SELECT id FROM articles WHERE canonical_url = ?').get(canonicalUrl) as
      | { id: number }
      | undefined;
    if (existing) {
      throw new ApiError(409, 'E_ARTICLE_EXISTS', '这篇文章已经在文章库里了', { articleId: existing.id });
    }
    if (body.sourceId !== undefined) {
      const source = db.prepare('SELECT id FROM sources WHERE id = ?').get(body.sourceId);
      if (!source) throw new ApiError(400, 'E_SOURCE_NOT_FOUND', '指定的来源不存在');
    }

    const summary = body.summary?.trim() ? body.summary.trim() : null;
    let articleId: number;
    try {
      const inserted = db
        .prepare(
          `INSERT INTO articles
             (source_id, title, canonical_url, original_url, summary, content_hash, content_access_level)
           VALUES
             (@sourceId, @title, @canonicalUrl, @originalUrl, @summary, @contentHash, @accessLevel)`,
        )
        .run({
          sourceId: body.sourceId ?? null,
          title: body.title,
          canonicalUrl,
          originalUrl: body.url,
          summary,
          contentHash: contentHash(body.title, summary),
          accessLevel: summary ? 'metadata' : 'link_only',
        });
      articleId = Number(inserted.lastInsertRowid);
    } catch (cause) {
      if (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)) {
        throw new ApiError(409, 'E_ARTICLE_EXISTS', '这篇文章已经在文章库里了');
      }
      throw cause;
    }

    return reply.code(201).send(getArticleDetail(db, articleId));
  });

  app.patch('/api/articles/:id/reading-state', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const patch = parseInput(readingStatePatchSchema, request.body ?? {});
    const article = updateReadingState(db, id, patch);
    if (!article) throw notFound('这篇文章不在文章库里');
    return article;
  });

  app.post('/api/articles/:id/extract', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const current = getArticleDetail(db, id);
    if (!current) throw notFound('这篇文章不在文章库里');
    if (current.accessLevel === 'user_provided') {
      throw new ApiError(409, 'E_CONTENT_USER_PROVIDED', '这篇文章的正文由你提供，提取不会覆盖它');
    }
    const result = await extractArticleContent(db, id, extractor);
    if (!result) throw notFound('这篇文章不在文章库里');
    return result;
  });

  app.post('/api/articles/manual-content', async (request) => {
    const body = parseInput(manualContentSchema, request.body ?? {});
    const article = saveManualContent(db, body.articleId, body.content);
    if (!article) throw notFound('这篇文章不在文章库里');
    return article;
  });
}
