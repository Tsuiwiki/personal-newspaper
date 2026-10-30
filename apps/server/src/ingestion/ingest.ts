import type { Db } from '../db/index.js';
import type { FeedEntry } from '../collectors/feed-parser.js';
import { canonicalizeUrl, contentHash, httpUrlOrNull } from './normalize.js';

export interface IngestStats {
  inserted: number;
  duplicates: number;
  skipped: number;
}

interface ExistingRow {
  id: number;
}

const EMPTY_STATS: IngestStats = { inserted: 0, duplicates: 0, skipped: 0 };

/**
 * 把 Feed 条目写进文章库。
 * 去重顺序：来源内稳定 ID → canonical URL → 内容指纹；命中任意一个都算重复，不更新已有文章。
 */
export function ingestEntries(db: Db, sourceId: number, entries: FeedEntry[]): IngestStats {
  const stats: IngestStats = { ...EMPTY_STATS };

  const byExternal = db.prepare<[number, string], ExistingRow>(
    'SELECT id FROM articles WHERE source_id = ? AND external_id = ?',
  );
  const byCanonical = db.prepare<[string], ExistingRow>('SELECT id FROM articles WHERE canonical_url = ?');
  const byHash = db.prepare<[string], ExistingRow>('SELECT id FROM articles WHERE content_hash = ?');
  const insert = db.prepare(
    `INSERT INTO articles
       (source_id, external_id, title, author, published_at, canonical_url, original_url,
        summary, image_url, content_hash, content_access_level)
     VALUES
       (@sourceId, @externalId, @title, @author, @publishedAt, @canonicalUrl, @originalUrl,
        @summary, @imageUrl, @contentHash, @accessLevel)`,
  );

  const run = db.transaction((rows: FeedEntry[]) => {
    for (const entry of rows) {
      const title = entry.title.trim();
      const canonicalUrl = canonicalizeUrl(entry.link);
      if (!title || !canonicalUrl) {
        stats.skipped += 1;
        continue;
      }

      if (entry.externalId && byExternal.get(sourceId, entry.externalId)) {
        stats.duplicates += 1;
        continue;
      }
      if (byCanonical.get(canonicalUrl)) {
        stats.duplicates += 1;
        continue;
      }
      const hash = contentHash(title, entry.summary);
      if (byHash.get(hash)) {
        stats.duplicates += 1;
        continue;
      }

      try {
        insert.run({
          sourceId,
          externalId: entry.externalId,
          title,
          author: entry.author,
          publishedAt: entry.publishedAt,
          canonicalUrl,
          originalUrl: entry.link,
          summary: entry.summary,
          imageUrl: httpUrlOrNull(entry.imageUrl),
          contentHash: hash,
          accessLevel: entry.summary ? 'metadata' : 'link_only',
        });
        stats.inserted += 1;
      } catch (cause) {
        // 同一批条目里重复、或与并发采集撞上唯一索引，按重复处理，不让整批回滚
        if (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)) {
          stats.duplicates += 1;
          continue;
        }
        throw cause;
      }
    }
  });

  run(entries);
  return stats;
}
