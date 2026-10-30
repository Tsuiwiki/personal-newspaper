import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_THEME } from '@paper/shared';
import { openDatabase, type Db } from '../src/db/index.js';
import { buildApp } from '../src/app.js';

let tmpDir: string;
let db: Db;
let app: FastifyInstance;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-test-'));
  db = await openDatabase({ databasePath: path.join(tmpDir, 'test.db'), backupDir: tmpDir });

  const source = db
    .prepare("INSERT INTO sources (name, type, url) VALUES ('测试源', 'rss', 'https://example.com/feed.xml')")
    .run();
  const sourceId = Number(source.lastInsertRowid);

  const template = db
    .prepare(
      `INSERT INTO templates (name, masthead_title, subtitle, theme_json, is_default)
       VALUES ('测试模板', '测试报', '副标题', ?, 1)`,
    )
    .run(JSON.stringify(DEFAULT_THEME));
  const templateId = Number(template.lastInsertRowid);

  const section = db
    .prepare(
      `INSERT INTO template_sections (template_id, name, sort_order, layout_type, max_articles)
       VALUES (?, '头版', 0, 'headline', 3)`,
    )
    .run(templateId);
  const sectionId = Number(section.lastInsertRowid);

  const article = db
    .prepare(
      `INSERT INTO articles (source_id, title, summary, canonical_url, original_url, content_access_level)
       VALUES (?, '第一篇测试文章', '这是摘要。', 'https://example.com/a', 'https://example.com/a', 'metadata')`,
    )
    .run(sourceId);
  const articleId = Number(article.lastInsertRowid);

  const issue = db
    .prepare(
      `INSERT INTO issues (issue_date, issue_number, template_id, template_snapshot_json, status)
       VALUES ('2026-10-28', 1, ?, ?, 'published')`,
    )
    .run(
      templateId,
      JSON.stringify({
        templateName: '测试模板',
        masthead: { title: '测试报', subtitle: '副标题', dateFormat: 'YYYY年M月D日 dddd' },
        theme: DEFAULT_THEME,
        sections: [{ id: sectionId, name: '头版', layoutType: 'headline', maxArticles: 3 }],
      }),
    );
  const issueId = Number(issue.lastInsertRowid);

  db.prepare(
    `INSERT INTO issue_articles (issue_id, article_id, section_id, section_name, layout_type, sort_order)
     VALUES (?, ?, ?, '头版', 'headline', 0)`,
  ).run(issueId, articleId, sectionId);

  app = buildApp(db);
  await app.ready();
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('GET /api/health 返回 ok', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
});

test('GET /api/issues/latest 返回期刊结构与文章', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/issues/latest' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.masthead.title, '测试报');
  assert.equal(body.sections.length, 1);
  assert.equal(body.sections[0].articles[0].title, '第一篇测试文章');
  assert.equal(body.stats.total, 1);
});

test('GET /api/issues 返回档案列表', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/issues' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].articleCount, 1);
});

test('读取不存在的文章返回 404 与稳定错误码', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/articles/9999' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'E_NOT_FOUND');
});

test('参数不合法返回 400', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/articles?pageSize=0' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'E_VALIDATION');
});

test('跨站写请求被拒绝', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/articles/1/reading-state',
    headers: { origin: 'https://evil.example' },
    payload: { status: 'read' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'E_ORIGIN_NOT_ALLOWED');
});

test('非本机 Host 头被拒绝', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/issues',
    headers: { host: 'attacker.example' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'E_HOST_NOT_ALLOWED');
});

test('更新阅读状态后文章与统计同步变化', async () => {
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/articles/1/reading-state',
    headers: { origin: 'http://localhost:5173' },
    payload: { status: 'later' },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().readingStatus, 'later');

  const issue = await app.inject({ method: 'GET', url: '/api/issues/latest' });
  assert.equal(issue.json().stats.later, 1);
});

test('笔记可保存、读取与清空，且不影响阅读状态', async () => {
  const saved = await app.inject({
    method: 'PATCH',
    url: '/api/articles/1/reading-state',
    headers: { origin: 'http://localhost:5173' },
    payload: { note: '  这一段值得回头再看  ' },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().note, '  这一段值得回头再看  ');
  assert.equal(saved.json().readingStatus, 'later');

  const detail = await app.inject({ method: 'GET', url: '/api/articles/1' });
  assert.equal(detail.json().note, '  这一段值得回头再看  ');

  const cleared = await app.inject({
    method: 'PATCH',
    url: '/api/articles/1/reading-state',
    headers: { origin: 'http://localhost:5173' },
    payload: { note: null },
  });
  assert.equal(cleared.json().note, null);
  assert.equal(cleared.json().readingStatus, 'later');
});

test('文章库支持分页、来源筛选与关键词搜索', async () => {
  const source = db
    .prepare("INSERT INTO sources (name, type, url) VALUES ('第二来源', 'rss', 'https://example.com/b.xml')")
    .run();
  const sourceId = Number(source.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO articles (source_id, title, summary, canonical_url, original_url, content_access_level)
     VALUES (?, ?, ?, ?, ?, 'metadata')`,
  );
  insert.run(sourceId, '第二篇：数据库观察', '关于 B 树的摘要。', 'https://example.com/b1', 'https://example.com/b1');
  insert.run(sourceId, '第三篇：编辑手记', '关于排版的摘要。', 'https://example.com/b2', 'https://example.com/b2');

  const firstPage = await app.inject({
    method: 'GET',
    url: '/api/articles?page=1&pageSize=2',
  });
  assert.equal(firstPage.statusCode, 200);
  assert.equal(firstPage.json().total, 3);
  assert.equal(firstPage.json().items.length, 2);

  const secondPage = await app.inject({
    method: 'GET',
    url: '/api/articles?page=2&pageSize=2',
  });
  assert.equal(secondPage.json().items.length, 1);
  const ids = new Set([...firstPage.json().items, ...secondPage.json().items].map((item: { id: number }) => item.id));
  assert.equal(ids.size, 3);

  const bySource = await app.inject({
    method: 'GET',
    url: `/api/articles?sourceId=${sourceId}`,
  });
  assert.equal(bySource.json().total, 2);

  const byQuery = await app.inject({
    method: 'GET',
    url: '/api/articles?q=数据库观察',
  });
  assert.equal(byQuery.json().total, 1);
  assert.equal(byQuery.json().items[0].sourceName, '第二来源');

  const combined = await app.inject({
    method: 'GET',
    url: `/api/articles?sourceId=${sourceId}&q=排版`,
  });
  assert.equal(combined.json().total, 1);
  assert.equal(combined.json().items[0].title, '第三篇：编辑手记');

  const none = await app.inject({
    method: 'GET',
    url: `/api/articles?sourceId=${sourceId}&q=不存在的关键词`,
  });
  assert.equal(none.json().total, 0);
  assert.deepEqual(none.json().items, []);
});
