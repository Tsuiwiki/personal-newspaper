import type { FastifyInstance } from 'fastify';
import {
  idParamSchema,
  sourceCreateSchema,
  sourcePatchSchema,
  type FetchAllResult,
  type SourceCreateResult,
} from '@paper/shared';
import type { Db } from '../db/index.js';
import { ApiError, notFound } from '../errors.js';
import { FeedParseError } from '../collectors/feed-parser.js';
import { fetchParsedFeed, fetchSource, probeFeed, type CollectorOptions } from '../ingestion/fetch-source.js';
import { ingestEntries } from '../ingestion/ingest.js';
import { collectEnabledSources } from '../services/job-service.js';
import {
  createSource,
  deleteSource,
  findSourceByUrl,
  getSourceRow,
  listSources,
  recordFetchOutcome,
  toSummary,
  updateSource,
} from '../services/source-service.js';
import { parseInput } from './input.js';

function feedError(cause: unknown): never {
  if (cause instanceof FeedParseError) {
    throw new ApiError(400, 'E_FEED_INVALID', cause.message);
  }
  throw cause;
}

export function registerSourceRoutes(app: FastifyInstance, db: Db, collector: CollectorOptions = {}): void {
  app.get('/api/sources', async () => ({ items: listSources(db) }));

  app.post('/api/sources', async (request, reply) => {
    const body = parseInput(sourceCreateSchema, request.body ?? {});
    if (findSourceByUrl(db, body.url)) {
      throw new ApiError(409, 'E_SOURCE_EXISTS', '这个地址已经添加过了');
    }

    const fetched = await fetchParsedFeed(body.url, collector).catch(feedError);

    const name = body.name ?? fetched.parsed.title ?? new URL(body.url).hostname;
    const id = createSource(db, {
      name,
      type: fetched.parsed.format,
      url: body.url,
      siteUrl: fetched.parsed.siteUrl,
      pollIntervalMinutes: body.pollIntervalMinutes ?? 60,
      enabled: body.enabled ?? true,
      extractContent: body.extractContent ?? false,
    });
    const stats = ingestEntries(db, id, fetched.parsed.entries);
    recordFetchOutcome(db, id, {
      status: 'ok',
      error: null,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      fetchedAt: new Date().toISOString(),
    });

    const row = getSourceRow(db, id)!;
    const result: SourceCreateResult = {
      source: toSummary(db, row),
      firstFetch: { ...stats, entryCount: fetched.parsed.entries.length },
    };
    return reply.code(201).send(result);
  });

  app.patch('/api/sources/:id', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const patch = parseInput(sourcePatchSchema, request.body ?? {});
    if (!getSourceRow(db, id)) throw notFound('这个来源不存在');
    updateSource(db, id, patch);
    return toSummary(db, getSourceRow(db, id)!);
  });

  app.delete('/api/sources/:id', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const result = deleteSource(db, id);
    if (!result) throw notFound('这个来源不存在');
    return { deleted: true, keptArticles: result.keptArticles };
  });

  app.post('/api/sources/:id/validate', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const row = getSourceRow(db, id);
    if (!row) throw notFound('这个来源不存在');
    const probe = await probeFeed(row.url, collector).catch(feedError);
    return {
      ok: true,
      feedTitle: probe.feedTitle,
      format: probe.format,
      siteUrl: probe.siteUrl,
      entryCount: probe.entryCount,
    };
  });

  app.post('/api/sources/:id/fetch', async (request) => {
    const { id } = parseInput(idParamSchema, request.params);
    const outcome = await fetchSource(db, id, collector);
    if (!outcome) throw notFound('这个来源不存在');
    if (!outcome.ok) {
      throw new ApiError(502, 'E_FETCH_FAILED', outcome.error ?? '采集失败', {
        sourceId: id,
        errorCode: outcome.errorCode,
      });
    }
    return { source: toSummary(db, getSourceRow(db, id)!), fetch: outcome };
  });

  app.post('/api/jobs/fetch-all', async () => {
    const collected = await collectEnabledSources(db, collector, { retries: 0 });
    const result: FetchAllResult = {
      results: collected.results,
      totals: collected.totals,
    };
    return result;
  });
}
