import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { openDatabase, type Db } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

const ORIGIN = 'http://localhost:5173';
const ETAG = '"feed-v1"';

let tmpDir: string;
let db: Db;
let app: FastifyInstance;
let feedServer: http.Server;
let baseUrl = '';
let conditionalHits = 0;
let feedId = 0;
let badSourceId = 0;

function rssFeed(base: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>测试日报</title>
    <link>${base}/</link>
    <item>
      <title>第一篇</title>
      <link>${base}/posts/1</link>
      <description><![CDATA[<p>摘要一</p>]]></description>
      <guid isPermaLink="false">p-1</guid>
    </item>
    <item>
      <title>第二篇</title>
      <link>${base}/posts/2</link>
    </item>
  </channel>
</rss>`;
}

function write(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'POST',
    url,
    headers: { origin: ORIGIN },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

function sourceById(id: number) {
  return db
    .prepare('SELECT last_status, last_error, enabled FROM sources WHERE id = ?')
    .get(id) as { last_status: string | null; last_error: string | null; enabled: number } | undefined;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-sources-'));
  db = await openDatabase({ databasePath: path.join(tmpDir, 'test.db'), backupDir: tmpDir });

  feedServer = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/feed.xml') {
      if (request.headers['if-none-match'] === ETAG) {
        conditionalHits += 1;
        response.writeHead(304, { etag: ETAG });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', etag: ETAG });
      response.end(rssFeed(baseUrl));
      return;
    }
    if (pathname === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body>不是 Feed</body></html>');
      return;
    }
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('boom');
  });
  await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  const { port } = feedServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  app = buildApp(db, {
    collector: { urlPolicy: { allowedPorts: [port], isAddressAllowed: () => true } },
  });
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  await new Promise<void>((resolve) => feedServer.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('新增来源：抓一次 Feed、解析元信息并入库', async () => {
  const response = await write('POST', '/api/sources', { url: `${baseUrl}/feed.xml` });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  feedId = body.source.id;

  assert.equal(body.source.name, '测试日报');
  assert.equal(body.source.type, 'rss');
  assert.equal(body.source.siteUrl, `${baseUrl}/`);
  assert.equal(body.source.enabled, true);
  assert.equal(body.source.pollIntervalMinutes, 60);
  assert.equal(body.source.lastStatus, 'ok');
  assert.equal(body.source.articleCount, 2);
  assert.deepEqual(body.firstFetch, { inserted: 2, duplicates: 0, skipped: 0, entryCount: 2 });

  const list = await app.inject({ method: 'GET', url: '/api/sources' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);
  assert.equal(list.json().items[0].id, feedId);
});

test('重复添加同一个地址返回 409', async () => {
  const response = await write('POST', '/api/sources', { url: `${baseUrl}/feed.xml` });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'E_SOURCE_EXISTS');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n, 1);
});

test('地址返回网页而不是 Feed 时返回 400 且不落库', async () => {
  const response = await write('POST', '/api/sources', { url: `${baseUrl}/page` });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'E_FEED_INVALID');
  assert.match(response.json().error.message, /网页而不是 Feed/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n, 1);
});

test('验证来源只读探测，不新增文章', async () => {
  const response = await write('POST', `/api/sources/${feedId}/validate`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    feedTitle: '测试日报',
    format: 'rss',
    siteUrl: `${baseUrl}/`,
    entryCount: 2,
  });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n, 2);
});

test('立即采集带条件请求，Feed 未变化时返回 not_modified', async () => {
  const response = await write('POST', `/api/sources/${feedId}/fetch`);
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.fetch.status, 'not_modified');
  assert.equal(body.fetch.inserted, 0);
  assert.equal(body.source.articleCount, 2);
  assert.ok(conditionalHits >= 1);
});

test('停用的来源不参与批量采集，重新启用后恢复', async () => {
  const disabled = await write('PATCH', `/api/sources/${feedId}`, { enabled: false });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().enabled, false);

  const skipped = await write('POST', '/api/jobs/fetch-all');
  assert.equal(skipped.statusCode, 200);
  assert.deepEqual(skipped.json().totals, { sources: 0, ok: 0, failed: 0, inserted: 0, duplicates: 0 });

  const enabled = await write('PATCH', `/api/sources/${feedId}`, { enabled: true, name: '改名后的日报' });
  assert.equal(enabled.json().enabled, true);
  assert.equal(enabled.json().name, '改名后的日报');
});

test('单个来源失败不影响其它来源，也不删除已有文章', async () => {
  badSourceId = Number(
    db
      .prepare("INSERT INTO sources (name, type, url) VALUES ('坏源', 'rss', ?)")
      .run(`${baseUrl}/broken`).lastInsertRowid,
  );

  const response = await write('POST', '/api/jobs/fetch-all');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.totals.sources, 2);
  assert.equal(body.totals.ok, 1);
  assert.equal(body.totals.failed, 1);

  const bad = body.results.find((item: { sourceId: number }) => item.sourceId === badSourceId);
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, 'E_FETCH_FAILED');
  assert.match(bad.error, /HTTP 500/);
  assert.equal(sourceById(badSourceId)!.last_status, 'error');
  assert.equal(sourceById(feedId)!.last_status, 'ok');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n, 2);
});

test('采集失败时立即采集返回 502，并写入来源状态', async () => {
  const response = await write('POST', `/api/sources/${badSourceId}/fetch`);
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, 'E_FETCH_FAILED');
  assert.equal(response.json().error.details.sourceId, badSourceId);
  assert.equal(sourceById(badSourceId)!.last_status, 'error');
  assert.match(sourceById(badSourceId)!.last_error ?? '', /HTTP 500/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n, 2);
});

test('手动添加链接：规范化、去重与来源校验', async () => {
  const created = await write('POST', '/api/articles/manual-link', {
    url: `${baseUrl}/manual?utm_source=x`,
    title: '手动收藏的一篇',
    summary: '我写的摘要',
    sourceId: feedId,
  });
  assert.equal(created.statusCode, 201);
  const article = created.json();
  assert.equal(article.title, '手动收藏的一篇');
  assert.equal(article.canonicalUrl, `${baseUrl}/manual`);
  assert.equal(article.accessLevel, 'metadata');
  assert.equal(article.summary, '我写的摘要');
  assert.equal(article.summaryIsSystem, true);
  assert.equal(article.sourceId, feedId);

  const duplicate = await write('POST', '/api/articles/manual-link', {
    url: `${baseUrl}/manual?utm_source=y`,
    title: '换个标题',
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, 'E_ARTICLE_EXISTS');
  assert.equal(duplicate.json().error.details.articleId, article.id);

  const invalid = await write('POST', '/api/articles/manual-link', {
    url: 'javascript:alert(1)',
    title: '坏链接',
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'E_VALIDATION');

  const unknownSource = await write('POST', '/api/articles/manual-link', {
    url: `${baseUrl}/manual-2`,
    title: '来源不存在',
    sourceId: 9999,
  });
  assert.equal(unknownSource.statusCode, 400);
  assert.equal(unknownSource.json().error.code, 'E_SOURCE_NOT_FOUND');
});

test('删除来源保留文章，文章变成无来源', async () => {
  const response = await write('DELETE', `/api/sources/${feedId}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { deleted: true, keptArticles: 3 });

  const rows = db.prepare('SELECT source_id FROM articles ORDER BY id').all() as Array<{ source_id: number | null }>;
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.source_id),
    [null, null, null],
  );

  const list = await app.inject({ method: 'GET', url: '/api/sources' });
  assert.equal(
    list.json().items.some((item: { id: number }) => item.id === feedId),
    false,
  );
});
