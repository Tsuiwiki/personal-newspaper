import { test } from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrator.js';
import { canonicalizeUrl, contentHash, decodeEntities, htmlToText, httpUrlOrNull } from '../src/ingestion/normalize.js';
import { ingestEntries } from '../src/ingestion/ingest.js';
import type { FeedEntry } from '../src/collectors/feed-parser.js';

function memoryDb() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}

function entry(patch: Partial<FeedEntry> = {}): FeedEntry {
  return {
    externalId: null,
    title: '标题',
    link: 'https://example.com/a',
    author: null,
    publishedAt: null,
    summary: null,
    imageUrl: null,
    ...patch,
  };
}

test('URL 规范化：去掉跟踪参数、排序参数、去锚点与末尾斜杠', () => {
  assert.equal(
    canonicalizeUrl('https://Example.COM:443/a/?utm_source=x&b=2&a=1#frag'),
    'https://example.com/a?a=1&b=2',
  );
  assert.equal(canonicalizeUrl('http://example.com:80/x'), 'http://example.com/x');
  assert.equal(canonicalizeUrl('https://example.com/'), 'https://example.com/');
  assert.equal(canonicalizeUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(canonicalizeUrl('/posts/1', 'https://example.com/blog/feed.xml'), 'https://example.com/posts/1');
  assert.equal(canonicalizeUrl('https://example.com/a?fbclid=1&gclid=2'), 'https://example.com/a');
});

test('URL 规范化是幂等的，非法协议与凭据一律拒绝', () => {
  const once = canonicalizeUrl('https://example.com/A%20B?utm_medium=rss&x=1')!;
  assert.equal(canonicalizeUrl(once), once);
  assert.equal(canonicalizeUrl('ftp://example.com/a'), null);
  assert.equal(canonicalizeUrl('javascript:alert(1)'), null);
  assert.equal(canonicalizeUrl('https://user:pass@example.com/a'), null);
  assert.equal(canonicalizeUrl('not a url'), null);
  assert.equal(canonicalizeUrl('   '), null);
});

test('图片地址只校验协议，保留查询参数', () => {
  assert.equal(httpUrlOrNull('https://cdn.example.com/i.jpg?w=800&sig=1'), 'https://cdn.example.com/i.jpg?w=800&sig=1');
  assert.equal(httpUrlOrNull('data:image/png;base64,AAAA'), null);
  assert.equal(httpUrlOrNull('javascript:alert(1)'), null);
  assert.equal(httpUrlOrNull('/cover.png', 'https://example.com/posts/1'), 'https://example.com/cover.png');
  assert.equal(httpUrlOrNull(null), null);
});

test('HTML 转纯文本：保留段落换行、去掉脚本、解码实体', () => {
  const text = htmlToText('<p>第一段 &amp; 上</p><script>alert(1)</script><p>第二段<br>换行</p>');
  assert.equal(text, '第一段 & 上\n第二段\n换行');
  assert.match(htmlToText('<ul><li>甲</li><li>乙</li></ul>'), /· 甲/);
  assert.equal(decodeEntities('&nbsp;&#x4e2d;&#0;&unknown;'), ' 中&unknown;');
});

test('内容指纹忽略空白差异，标题变化则不同', () => {
  assert.equal(contentHash('标题', '第一段\n摘要'), contentHash('  标题  ', '第一段   摘要'));
  assert.notEqual(contentHash('标题 A', null), contentHash('标题 B', null));
});

test('入库去重：同一批重复、再次采集、跨来源同链接都不会重复创建', () => {
  const db = memoryDb();
  const sourceA = Number(
    db.prepare("INSERT INTO sources (name, type, url) VALUES ('A', 'rss', 'https://a.example.com/feed')").run()
      .lastInsertRowid,
  );
  const sourceB = Number(
    db.prepare("INSERT INTO sources (name, type, url) VALUES ('B', 'rss', 'https://b.example.com/feed')").run()
      .lastInsertRowid,
  );

  const entries: FeedEntry[] = [
    entry({ externalId: 'g-1', title: '第一篇', summary: '摘要一' }),
    entry({ externalId: 'g-2', title: '第二篇', link: 'https://example.com/b?utm_source=rss' }),
    entry({ title: '没有链接', link: '' }),
  ];

  const first = ingestEntries(db, sourceA, entries);
  assert.deepEqual(first, { inserted: 2, duplicates: 0, skipped: 1 });

  const again = ingestEntries(db, sourceA, entries);
  assert.deepEqual(again, { inserted: 0, duplicates: 2, skipped: 1 });

  const sameGuidNewLink = ingestEntries(db, sourceA, [entry({ externalId: 'g-1', title: '改过的标题', link: 'https://example.com/moved' })]);
  assert.deepEqual(sameGuidNewLink, { inserted: 0, duplicates: 1, skipped: 0 });

  const sameUrlOtherSource = ingestEntries(db, sourceB, [entry({ title: '转载', link: 'https://example.com/a' })]);
  assert.deepEqual(sameUrlOtherSource, { inserted: 0, duplicates: 1, skipped: 0 });

  const sameTextNewUrl = ingestEntries(db, sourceB, [entry({ title: '第一篇', link: 'https://other.example.com/x', summary: '摘要一' })]);
  assert.deepEqual(sameTextNewUrl, { inserted: 0, duplicates: 1, skipped: 0 });

  const rows = db
    .prepare('SELECT title, canonical_url, external_id, content_access_level, image_url FROM articles ORDER BY id')
    .all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.canonical_url, 'https://example.com/a');
  assert.equal(rows[0]!.external_id, 'g-1');
  assert.equal(rows[0]!.content_access_level, 'metadata');
  assert.equal(rows[1]!.content_access_level, 'link_only');
  assert.equal(rows[1]!.canonical_url, 'https://example.com/b');
});

test('入库时丢掉非 http(s) 的图片地址', () => {
  const db = memoryDb();
  const sourceId = Number(
    db.prepare("INSERT INTO sources (name, type, url) VALUES ('A', 'rss', 'https://a.example.com/feed')").run()
      .lastInsertRowid,
  );
  ingestEntries(db, sourceId, [entry({ imageUrl: 'data:image/png;base64,AAAA' })]);
  const row = db.prepare('SELECT image_url FROM articles').get() as { image_url: string | null };
  assert.equal(row.image_url, null);
});
