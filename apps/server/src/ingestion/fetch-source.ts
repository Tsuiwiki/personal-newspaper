import { safeFetch, GuardError, type SafeFetchOptions, type SafeFetchResult, type UrlPolicy } from '../security/url-guard.js';
import { parseFeed, FeedParseError, type ParsedFeed } from '../collectors/feed-parser.js';
import type { Db } from '../db/index.js';
import { logger } from '../logger.js';
import { autoExtractNewArticles } from '../services/extraction-service.js';
import { getSourceRow, recordFetchOutcome, type SourceRow } from '../services/source-service.js';
import { ingestEntries, type IngestStats } from './ingest.js';

const log = logger.child('fetch');

export interface CollectorOptions {
  /** 便于测试注入；默认走带 SSRF 防护的 safeFetch */
  fetchImpl?: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
  /** 测试里放行本地地址用；生产不要传 */
  urlPolicy?: UrlPolicy;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface SourceFetchOutcome extends IngestStats {
  sourceId: number;
  name: string;
  ok: boolean;
  status: 'ok' | 'not_modified' | 'error';
  entryCount: number;
  feedTitle: string | null;
  error: string | null;
  errorCode: string | null;
  /** 本次采集后自动提取成功的新文章数 */
  extracted: number;
}

function maxArticleId(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM articles').get() as { id: number }).id;
}

export interface FeedProbe {
  format: ParsedFeed['format'];
  feedTitle: string | null;
  siteUrl: string | null;
  entryCount: number;
  etag: string | null;
  lastModified: string | null;
}

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.5';

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** 错误信息会写进数据库并展示在来源页：去掉控制字符、压缩空白、限长 */
function describeError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '采集失败';
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

interface FeedResponse {
  notModified: boolean;
  parsed: ParsedFeed | null;
  etag: string | null;
  lastModified: string | null;
}

async function fetchFeed(
  url: string,
  deps: CollectorOptions,
  conditional: { etag: string | null; lastModified: string | null },
): Promise<FeedResponse> {
  const fetchImpl = deps.fetchImpl ?? safeFetch;
  const headers: Record<string, string> = {};
  if (conditional.etag) headers['if-none-match'] = conditional.etag;
  if (conditional.lastModified) headers['if-modified-since'] = conditional.lastModified;

  const response = await fetchImpl(url, {
    ...(deps.urlPolicy ?? {}),
    headers,
    accept: FEED_ACCEPT,
    timeoutMs: deps.timeoutMs ?? 15_000,
    maxBytes: deps.maxBytes ?? 2 * 1024 * 1024,
    maxRedirects: 3,
  });

  const etag = headerValue(response.headers.etag);
  const lastModified = headerValue(response.headers['last-modified']);

  if (response.status === 304) {
    return { notModified: true, parsed: null, etag, lastModified };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new FeedParseError(`来源返回 HTTP ${response.status}`);
  }

  const parsed = parseFeed(response.body, response.finalUrl || url);
  return { notModified: false, parsed, etag, lastModified };
}

/** 无条件拉取并解析，用于新增来源时的首次验证（这一份结果直接用来入库，避免抓两次） */
export interface FetchedFeed {
  parsed: ParsedFeed;
  etag: string | null;
  lastModified: string | null;
}

export async function fetchParsedFeed(url: string, deps: CollectorOptions = {}): Promise<FetchedFeed> {
  const result = await fetchFeed(url, deps, { etag: null, lastModified: null });
  if (!result.parsed) throw new FeedParseError('来源返回了 304，但这次没有可复用的缓存');
  return { parsed: result.parsed, etag: result.etag, lastModified: result.lastModified };
}

/** 只读探测：拉取并解析，不写文章、不改采集状态。用于「验证来源」 */
export async function probeFeed(url: string, deps: CollectorOptions = {}): Promise<FeedProbe> {
  const result = await fetchParsedFeed(url, deps);
  return {
    format: result.parsed.format,
    feedTitle: result.parsed.title,
    siteUrl: result.parsed.siteUrl,
    entryCount: result.parsed.entries.length,
    etag: result.etag,
    lastModified: result.lastModified,
  };
}

/**
 * 采集一个来源：
 * - 带 If-None-Match / If-Modified-Since，命中 304 就不解析；
 * - 解析后按稳定 ID / canonical URL / 内容指纹去重入库；
 * - 任何失败都只更新这台来源的状态，已有文章一条不动。
 */
export async function fetchSource(
  db: Db,
  sourceId: number,
  deps: CollectorOptions = {},
): Promise<SourceFetchOutcome | null> {
  const source: SourceRow | null = getSourceRow(db, sourceId);
  if (!source) return null;

  const fetchedAt = new Date().toISOString();
  const base: SourceFetchOutcome = {
    sourceId: source.id,
    name: source.name,
    ok: true,
    status: 'ok',
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    entryCount: 0,
    feedTitle: null,
    error: null,
    errorCode: null,
    extracted: 0,
  };

  try {
    const result = await fetchFeed(source.url, deps, {
      etag: source.etag,
      lastModified: source.last_modified,
    });

    if (result.notModified) {
      recordFetchOutcome(db, source.id, {
        status: 'ok',
        error: null,
        etag: source.etag,
        lastModified: source.last_modified,
        fetchedAt,
      });
      return { ...base, status: 'not_modified' };
    }

    const parsed = result.parsed!;
    const beforeId = maxArticleId(db);
    const stats = ingestEntries(db, source.id, parsed.entries);

    recordFetchOutcome(db, source.id, {
      status: 'ok',
      error: null,
      etag: result.etag,
      lastModified: result.lastModified,
      fetchedAt,
    });
    if (!source.site_url && parsed.siteUrl) {
      db.prepare('UPDATE sources SET site_url = ? WHERE id = ?').run(parsed.siteUrl, source.id);
    }

    let extracted = 0;
    if (source.extract_content === 1 && stats.inserted > 0) {
      try {
        extracted = await autoExtractNewArticles(db, source.id, beforeId, deps);
      } catch (cause) {
        // 正文提取是采集后的增值步骤，不能反过来把一次成功的采集记成失败
        log.warn('采集后自动提取正文失败', {
          sourceId: source.id,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    return { ...base, ...stats, entryCount: parsed.entries.length, feedTitle: parsed.title, extracted };
  } catch (cause) {
    const message = describeError(cause);
    const errorCode = cause instanceof GuardError ? cause.code : 'E_FETCH_FAILED';
    recordFetchOutcome(db, source.id, {
      status: 'error',
      error: message,
      etag: source.etag,
      lastModified: source.last_modified,
      fetchedAt,
    });
    return { ...base, ok: false, status: 'error', error: message, errorCode };
  }
}
