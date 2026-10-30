import { test } from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { applyMigrations } from '../src/db/migrator.js';
import type { Db } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { GuardError, type SafeFetchResult } from '../src/security/url-guard.js';

const ORIGIN = 'http://localhost:5173';
const BODY_A =
  '这是正文的第一段，用来确认提取器只保留文章内容，不把导航、推荐位和版权声明一起存下来。'.repeat(8);
const BODY_B =
  '这是正文的第二段，段落之间应该保留空行，读起来才像一篇正常的文章而不是一整块文字。'.repeat(8);

interface FakeRoute {
  status?: number;
  contentType?: string;
  body: string;
}

type Handler = (url: string) => FakeRoute | Error;

function memoryDb(): Db {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}

function fakeFetch(handler: Handler): (url: string) => Promise<SafeFetchResult> {
  return async (url: string) => {
    const route = handler(url);
    if (route instanceof Error) throw route;
    return {
      status: route.status ?? 200,
      headers: { 'content-type': route.contentType ?? 'text/html; charset=utf-8' },
      body: route.body,
      finalUrl: url,
      redirects: 0,
    };
  };
}

function makeApp(db: Db, handler: Handler): FastifyInstance {
  return buildApp(db, { collector: { fetchImpl: fakeFetch(handler) } });
}

function write(app: FastifyInstance, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'POST',
    url,
    headers: { origin: ORIGIN },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function addManualArticle(app: FastifyInstance, url: string, title: string): Promise<number> {
  const response = await write(app, 'POST', '/api/articles/manual-link', {
    url,
    title,
    summary: '这是一段来自 Feed 或手动填写的摘要。',
  });
  assert.equal(response.statusCode, 201);
  return (response.json() as { id: number }).id;
}

function articlePage(title: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head><title>${title}</title></head>
  <body>
    <nav><a href="/">首页</a><a href="/about">关于我们</a></nav>
    <header>站点头图</header>
    <article>
      <h1>${title}</h1>
      <p>${BODY_A}</p>
      <p>${BODY_B}</p>
    </article>
    <aside>热门推荐：三篇你可能会喜欢的文章</aside>
    <footer>版权所有 2026 示例站点</footer>
    <script>alert('should not be saved')</script>
  </body>
</html>`;
}

test('公开页面提取：只保存文章纯文本，并标记为 extracted', async () => {
  const db = memoryDb();
  const app = makeApp(db, () => ({ body: articlePage('一篇公开文章') }));
  const id = await addManualArticle(app, 'https://example.test/posts/1', '一篇公开文章');

  const response = await write(app, 'POST', `/api/articles/${id}/extract`);
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.ok, true);
  assert.equal(body.error, null);
  assert.ok(body.characters > 300);
  assert.equal(body.truncated, false);
  assert.equal(body.article.accessLevel, 'extracted');
  assert.equal(body.article.hasFullText, true);
  assert.equal(body.article.extractError, null);
  assert.ok(body.article.extractedAt);
  assert.match(body.article.contentText, /正文的第一段/);
  assert.match(body.article.contentText, /\n\n/);
  assert.doesNotMatch(body.article.contentText, /热门推荐|版权所有|should not be saved|首页/);
  assert.ok(!body.article.contentText.startsWith('一篇公开文章'), '标题不应重复出现在正文第一段');

  const detail = await app.inject({ method: 'GET', url: `/api/articles/${id}` });
  assert.equal(detail.json().contentText, body.article.contentText);

  await app.close();
  db.close();
});

test('页面标题与 h1 不一致时，正文开头重复的标题也会去掉', async () => {
  const db = memoryDb();
  const html = articlePage('页面上的大标题').replace(
    '<title>页面上的大标题</title>',
    '<title>站点名｜栏目</title>',
  );
  const app = makeApp(db, () => ({ body: html }));
  const id = await addManualArticle(app, 'https://example.test/posts/heading', '文章库里的标题');

  const response = await write(app, 'POST', `/api/articles/${id}/extract`);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.match(body.article.contentText, /^这是正文的第一段/);
  assert.doesNotMatch(body.article.contentText, /页面上的大标题/);

  await app.close();
  db.close();
});

test('提取失败保留原有元数据，并把原因记在文章上', async () => {
  const db = memoryDb();
  const app = makeApp(db, () => new GuardError('E_URL_ADDRESS_BLOCKED', '目标地址属于内网或保留地址'));
  const id = await addManualArticle(app, 'https://example.test/posts/2', '提取失败的文章');

  const response = await write(app, 'POST', `/api/articles/${id}/extract`);
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_URL_ADDRESS_BLOCKED');
  assert.match(body.error.message, /内网|保留地址/);
  assert.equal(body.article.accessLevel, 'metadata');
  assert.equal(body.article.contentText, null);
  assert.equal(body.article.hasFullText, false);
  assert.equal(body.article.extractedAt, null);
  assert.match(body.article.extractError ?? '', /内网|保留地址/);
  assert.equal(body.article.summary, '这是一段来自 Feed 或手动填写的摘要。');

  await app.close();
  db.close();
});

test('页面过短或不是 HTML 时不写入正文', async () => {
  const db = memoryDb();
  const app = makeApp(db, (url) => {
    if (url.endsWith('/short')) {
      return { body: '<!doctype html><html><body><nav>首页 关于</nav><p>太短了。</p></body></html>' };
    }
    return { contentType: 'application/pdf', body: '%PDF-1.7 fake' };
  });
  const shortId = await addManualArticle(app, 'https://example.test/short', '过短的页面');
  const pdfId = await addManualArticle(app, 'https://example.test/file.pdf', '不是网页');

  const short = await write(app, 'POST', `/api/articles/${shortId}/extract`);
  assert.equal(short.json().ok, false);
  assert.equal(short.json().error.code, 'E_EXTRACT_TOO_SHORT');
  assert.equal(short.json().article.contentText, null);

  const pdf = await write(app, 'POST', `/api/articles/${pdfId}/extract`);
  assert.equal(pdf.json().ok, false);
  assert.equal(pdf.json().error.code, 'E_EXTRACT_UNSUPPORTED');
  assert.equal(pdf.json().article.accessLevel, 'metadata');

  await app.close();
  db.close();
});

test('拒绝提取页面会明确报错，不会尝试绕过', async () => {
  const db = memoryDb();
  const app = makeApp(db, () => ({ status: 403, body: 'forbidden' }));
  const id = await addManualArticle(app, 'https://example.test/private', '需要登录的文章');

  const response = await write(app, 'POST', `/api/articles/${id}/extract`);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_EXTRACT_ACCESS_DENIED');
  assert.match(body.error.message, /HTTP 403/);
  assert.equal(body.article.contentText, null);

  await app.close();
  db.close();
});

test('手动正文导入：清洗换行并标记 user_provided，之后提取不会覆盖', async () => {
  const db = memoryDb();
  const app = makeApp(db, () => ({ body: articlePage('用户提供的正文') }));
  const id = await addManualArticle(app, 'https://example.test/posts/3', '用户提供的正文');

  const manual = await write(app, 'POST', '/api/articles/manual-content', {
    articleId: id,
    content: `第一段用户自己保存的正文，用来确认换行会被整理。\r\n\r\n\r\n${BODY_B}   `,
  });
  assert.equal(manual.statusCode, 200);
  const article = manual.json();
  assert.equal(article.accessLevel, 'user_provided');
  assert.equal(article.hasFullText, true);
  assert.equal(article.extractedAt, null);
  assert.equal(article.extractError, null);
  assert.doesNotMatch(article.contentText, /\r/);
  assert.doesNotMatch(article.contentText, /\n{3,}/);

  const refused = await write(app, 'POST', `/api/articles/${id}/extract`);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, 'E_CONTENT_USER_PROVIDED');

  const detail = await app.inject({ method: 'GET', url: `/api/articles/${id}` });
  assert.equal(detail.json().contentText, article.contentText);
  assert.equal(detail.json().accessLevel, 'user_provided');

  await app.close();
  db.close();
});

test('手动正文太短会被校验拦下', async () => {
  const db = memoryDb();
  const app = makeApp(db, () => ({ body: articlePage('短正文') }));
  const id = await addManualArticle(app, 'https://example.test/posts/4', '短正文');

  const response = await write(app, 'POST', '/api/articles/manual-content', {
    articleId: id,
    content: '太短',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'E_VALIDATION');

  await app.close();
  db.close();
});

function feed(base: string, count: number): string {
  const items = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return `<item><title>自动提取第 ${n} 篇</title><link>${base}/posts/${n}</link>` +
      `<guid>auto-${n}</guid><description>第 ${n} 篇摘要</description></item>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
    `<title>自动提取测试源</title><link>${base}/</link>${items}</channel></rss>`;
}

test('来源开启自动提取后，只处理本次新文章、每次最多 3 篇，失败不影响采集', async () => {
  const db = memoryDb();
  const app = makeApp(db, (url) => {
    if (url.endsWith('/feed.xml')) {
      return { contentType: 'application/rss+xml', body: feed('https://example.test', 5) };
    }
    if (url.endsWith('/posts/2')) {
      return { status: 403, body: 'forbidden' };
    }
    if (url.endsWith('/posts/3')) {
      return { body: '<!doctype html><html><body><p>太短。</p></body></html>' };
    }
    const n = url.slice(url.lastIndexOf('/') + 1);
    return { body: articlePage(`自动提取第 ${n} 篇`) };
  });

  const source = db
    .prepare("INSERT INTO sources (name, type, url, extract_content) VALUES ('自动提取源', 'rss', ?, 1)")
    .run('https://example.test/feed.xml');
  const sourceId = Number(source.lastInsertRowid);

  const response = await write(app, 'POST', `/api/sources/${sourceId}/fetch`);
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.fetch.ok, true);
  assert.equal(result.fetch.inserted, 5);
  assert.equal(result.fetch.extracted, 1);
  assert.equal(result.source.extractContent, true);

  const rows = db
    .prepare(
      `SELECT id, content_access_level, content_text, extract_error
       FROM articles ORDER BY id`,
    )
    .all() as Array<{
    id: number;
    content_access_level: string;
    content_text: string | null;
    extract_error: string | null;
  }>;
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((row) => row.content_access_level),
    ['extracted', 'metadata', 'metadata', 'metadata', 'metadata'],
  );
  assert.match(rows[0]?.content_text ?? '', /正文的第一段/);
  assert.match(rows[1]?.extract_error ?? '', /HTTP 403/);
  assert.match(rows[2]?.extract_error ?? '', /正文门槛/);
  // 超过单次 3 篇预算的第 4、5 篇仍然保留链接，留给之后手动提取
  assert.equal(rows[3]?.extract_error, null);
  assert.equal(rows[4]?.extract_error, null);

  const patched = await write(app, 'PATCH', `/api/sources/${sourceId}`, { extractContent: false });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().extractContent, false);

  await app.close();
  db.close();
});
