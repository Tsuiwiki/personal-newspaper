import { test } from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_THEME, type TemplateSectionInput } from '@paper/shared';
import { applyMigrations } from '../src/db/migrator.js';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import {
  copyTemplate,
  createTemplate,
  listTemplates,
  setDefaultTemplate,
  updateTemplate,
} from '../src/services/template-service.js';
import { buildIssuePreview, generateIssue, publishIssue } from '../src/services/issue-builder.js';
import { getIssueRow, toIssueView } from '../src/services/issue-service.js';

const ORIGIN = 'http://localhost:5173';
const DATE = '2026-10-28';
const NEXT_DATE = '2026-10-29';

function memoryDb(): Db {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}

function addSource(db: Db, name: string, enabled = true): number {
  const info = db
    .prepare('INSERT INTO sources (name, type, url, enabled) VALUES (?, ?, ?, ?)')
    .run(name, 'rss', `https://example.test/${encodeURIComponent(name)}/feed.xml`, enabled ? 1 : 0);
  return Number(info.lastInsertRowid);
}

let articleSeq = 0;
function addArticle(
  db: Db,
  options: {
    sourceId?: number | null;
    title: string;
    publishedAt: string;
    summary?: string | null;
    contentText?: string | null;
  },
): number {
  articleSeq += 1;
  const slug = `a-${articleSeq}`;
  const info = db
    .prepare(
      `INSERT INTO articles
         (source_id, title, published_at, discovered_at, canonical_url, original_url, summary,
          content_text, content_hash, content_access_level)
       VALUES
         (@sourceId, @title, @publishedAt, @publishedAt, @canonicalUrl, @originalUrl, @summary,
          @contentText, @contentHash, @accessLevel)`,
    )
    .run({
      sourceId: options.sourceId ?? null,
      title: options.title,
      publishedAt: options.publishedAt,
      canonicalUrl: `https://example.test/read/${slug}`,
      originalUrl: `https://example.test/read/${slug}`,
      summary: options.summary ?? `${options.title} 的摘要`,
      contentText: options.contentText ?? null,
      contentHash: `hash-${slug}`,
      accessLevel: options.contentText ? 'user_provided' : 'metadata',
    });
  return Number(info.lastInsertRowid);
}

function section(
  name: string,
  layoutType: TemplateSectionInput['layoutType'],
  maxArticles: number,
  patch: Partial<TemplateSectionInput> = {},
): TemplateSectionInput {
  return { name, layoutType, maxArticles, filter: {}, sortRule: 'published_desc', ...patch };
}

function makeTemplate(
  db: Db,
  sections: TemplateSectionInput[],
  patch: { name?: string; maxTotalArticles?: number } = {},
) {
  return createTemplate(db, {
    name: patch.name ?? '测试模板',
    mastheadTitle: '纸间',
    subtitle: '测试副标题',
    dateFormat: 'YYYY年M月D日 dddd',
    theme: DEFAULT_THEME,
    maxTotalArticles: patch.maxTotalArticles ?? 15,
    sections,
  });
}

function preview(db: Db, extra: { date?: string; maxTotal?: number } = {}) {
  return buildIssuePreview(db, {
    date: extra.date ?? DATE,
    timeZone: 'Asia/Shanghai',
  });
}

function write(app: FastifyInstance, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'POST',
    url,
    headers: { origin: ORIGIN },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

test('预览按栏目顺序和容量选文章，不写任何库记录', () => {
  const db = memoryDb();
  const source = addSource(db, '来源甲');
  for (let i = 1; i <= 6; i += 1) {
    addArticle(db, {
      sourceId: source,
      title: `文章 ${i}`,
      publishedAt: `2026-10-28T0${i}:00:00.000Z`,
    });
  }
  makeTemplate(
    db,
    [section('头版', 'headline', 2), section('深读', 'feature', 3), section('简讯', 'brief', 3)],
    { maxTotalArticles: 4 },
  );

  const result = preview(db);
  assert.equal(result.sections.length, 3);
  assert.equal(result.sections[0]!.articles.length, 2);
  assert.equal(result.sections[1]!.articles.length, 2);
  assert.equal(result.sections[2]!.articles.length, 0);
  assert.equal(result.total, 4);
  assert.equal(result.sections[0]!.articles[0]!.title, '文章 6');
  assert.equal(result.sections[1]!.articles[0]!.title, '文章 4');
  assert.equal(new Set(result.sections.flatMap((s) => s.articles.map((a) => a.id))).size, 4);
  assert.equal(result.emptyReason, null);
  assert.equal(result.existingIssue, null);

  const issueCount = db.prepare('SELECT COUNT(*) AS n FROM issues').get() as { n: number };
  assert.equal(issueCount.n, 0);
  db.close();
});

test('生成期刊写入快照与版面条目，之后改模板不影响已生成期刊', () => {
  const db = memoryDb();
  const source = addSource(db, '来源甲');
  for (let i = 1; i <= 4; i += 1) {
    addArticle(db, {
      sourceId: source,
      title: `文章 ${i}`,
      publishedAt: `2026-10-28T0${i}:00:00.000Z`,
    });
  }
  const template = makeTemplate(
    db,
    [section('头版', 'headline', 2), section('简讯', 'brief', 2)],
    { maxTotalArticles: 4 },
  );

  const first = generateIssue(db, { date: DATE, timeZone: 'Asia/Shanghai' });
  assert.equal(first.generated, true);
  assert.equal(first.replacedDraft, false);
  assert.equal(first.issue?.status, 'draft');
  assert.equal(first.issue?.stats.total, 4);

  const issueId = first.issue!.id;
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM issue_articles WHERE issue_id = ?').get(issueId) as { n: number }).n,
    4,
  );
  const snapshot = JSON.parse(
    (db.prepare('SELECT template_snapshot_json FROM issues WHERE id = ?').get(issueId) as {
      template_snapshot_json: string;
    }).template_snapshot_json,
  ) as { maxTotalArticles: number; sections: Array<{ filter: unknown; sortRule: string }> };
  assert.equal(snapshot.maxTotalArticles, 4);
  assert.equal(snapshot.sections[0]!.sortRule, 'published_desc');

  updateTemplate(db, template.id, {
    mastheadTitle: '改过的刊名',
    sections: [section('新栏目', 'double', 1)],
  });
  const stored = toIssueView(db, getIssueRow(db, issueId)!);
  assert.equal(stored.masthead.title, '纸间');
  assert.equal(stored.sections.length, 2);
  assert.equal(stored.sections[0]!.name, '头版');

  assert.throws(
    () => generateIssue(db, { date: DATE, timeZone: 'Asia/Shanghai' }),
    /今天已有一份预览稿/,
  );
  const replaced = generateIssue(db, {
    date: DATE,
    timeZone: 'Asia/Shanghai',
    replaceDraft: true,
  });
  assert.equal(replaced.replacedDraft, true);
  assert.equal(replaced.issue?.id, issueId);
  // 替换草稿会用“当前”模板重新编排：改过的模板只留一个栏目、上限 1 篇
  assert.equal(replaced.issue?.masthead.title, '改过的刊名');
  assert.equal(replaced.issue?.sections.length, 1);
  assert.equal(replaced.issue?.stats.total, 1);

  publishIssue(db, issueId);
  assert.equal(getIssueRow(db, issueId)!.status, 'published');
  assert.throws(
    () => generateIssue(db, { date: DATE, timeZone: 'Asia/Shanghai', replaceDraft: true }),
    /已经出版/,
  );
  db.close();
});

test('候选只含启用来源、时间窗口内、未被别期用过的文章', () => {
  const db = memoryDb();
  const enabled = addSource(db, '启用来源');
  const disabled = addSource(db, '停用来源', false);
  const a1 = addArticle(db, { sourceId: enabled, title: '启用一', publishedAt: '2026-10-28T02:00:00.000Z' });
  const a2 = addArticle(db, { sourceId: enabled, title: '启用二', publishedAt: '2026-10-27T02:00:00.000Z' });
  addArticle(db, { sourceId: enabled, title: '太旧', publishedAt: '2026-10-20T02:00:00.000Z' });
  addArticle(db, { sourceId: disabled, title: '停用来源文章', publishedAt: '2026-10-28T03:00:00.000Z' });
  const manual = addArticle(db, { title: '手动链接文章', publishedAt: '2026-10-28T04:00:00.000Z' });

  makeTemplate(db, [section('全部', 'list', 10)], { maxTotalArticles: 3 });

  const first = preview(db);
  assert.deepEqual(
    first.sections[0]!.articles.map((article) => article.id),
    [manual, a1, a2],
  );
  assert.equal(first.candidates.eligible, 3);
  assert.equal(first.candidates.used, 0);

  generateIssue(db, { date: DATE, timeZone: 'Asia/Shanghai', publish: true });
  const second = preview(db, { date: NEXT_DATE });
  assert.equal(second.candidates.used, 3);
  assert.equal(second.candidates.eligible, 0);
  assert.equal(second.total, 0);
  assert.equal(second.emptyReason, 'all_used');
  db.close();
});

test('栏目来源筛选、来源优先级和回溯天数生效', () => {
  const db = memoryDb();
  const sourceA = addSource(db, '来源 A');
  const sourceB = addSource(db, '来源 B');
  const b1 = addArticle(db, { sourceId: sourceB, title: 'B 一', publishedAt: '2026-10-28T01:00:00.000Z' });
  const b2 = addArticle(db, { sourceId: sourceB, title: 'B 二', publishedAt: '2026-10-28T02:00:00.000Z' });
  const aNew = addArticle(db, { sourceId: sourceA, title: 'A 新', publishedAt: '2026-10-28T10:00:00.000Z' });
  const aOlder = addArticle(db, { sourceId: sourceA, title: 'A 旧', publishedAt: '2026-10-27T00:00:00.000Z' });

  makeTemplate(
    db,
    [
      section('来源优先', 'double', 2, {
        filter: { sourceIds: [sourceB, sourceA] },
        sortRule: 'source_priority',
      }),
      section('A 近一天', 'list', 4, {
        filter: { sourceIds: [sourceA], maxAgeDays: 1 },
      }),
    ],
    { maxTotalArticles: 10 },
  );

  const result = preview(db);
  assert.deepEqual(result.sections[0]!.articles.map((a) => a.id), [b2, b1]);
  assert.equal(result.sections[0]!.matched, 4);
  assert.equal(result.sections[1]!.matched, 1);
  assert.deepEqual(result.sections[1]!.articles.map((a) => a.id), [aNew]);
  assert.ok(!result.sections.flatMap((s) => s.articles.map((a) => a.id)).includes(aOlder));
  db.close();
});

test('没有候选时不生成空刊', () => {
  const db = memoryDb();
  makeTemplate(db, [section('头版', 'headline', 3)]);
  const empty = preview(db);
  assert.equal(empty.total, 0);
  assert.equal(empty.emptyReason, 'no_recent');

  const result = generateIssue(db, { date: DATE, timeZone: 'Asia/Shanghai' });
  assert.equal(result.generated, false);
  assert.equal(result.reason, 'no_recent');
  assert.equal(result.issue, null);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM issues').get() as { n: number }).n, 0);
  db.close();
});

test('模板：新建、修改、复制、设为默认，栏目重名与主题越界被拒绝', () => {
  const db = memoryDb();
  const first = makeTemplate(db, [section('头版', 'headline', 3)], { name: '默认模板' });
  assert.equal(first.isDefault, true);

  const second = makeTemplate(
    db,
    [section('列表', 'list', 4), section('简讯', 'brief', 5)],
    { name: '第二个模板' },
  );
  assert.equal(second.isDefault, false);

  const updated = updateTemplate(db, second.id, {
    name: '改名后的模板',
    sections: [section('深读', 'feature', 2, { filter: { sourceIds: [1], maxAgeDays: 30 } })],
  });
  assert.equal(updated.name, '改名后的模板');
  assert.equal(updated.sections.length, 1);
  assert.equal(updated.sections[0]!.filter.maxAgeDays, 30);

  const copied = copyTemplate(db, first.id);
  assert.match(copied.name, /副本/);
  assert.equal(copied.isDefault, false);
  assert.equal(copied.sections[0]!.name, '头版');

  const promoted = setDefaultTemplate(db, second.id);
  assert.equal(promoted.isDefault, true);
  const all = listTemplates(db);
  assert.equal(all.filter((template) => template.isDefault).length, 1);
  assert.equal(all.find((template) => template.id === first.id)!.isDefault, false);
  db.close();
});

test('模板与期刊接口：契约、冲突与发布', async () => {
  const db = memoryDb();
  const app = buildApp(db);
  const source = addSource(db, '接口来源');
  addArticle(db, { sourceId: source, title: '接口文章一', publishedAt: '2026-10-28T02:00:00.000Z' });
  addArticle(db, { sourceId: source, title: '接口文章二', publishedAt: '2026-10-28T03:00:00.000Z' });

  const created = await write(app, 'POST', '/api/templates', {
    name: '接口模板',
    mastheadTitle: '接口报',
    sections: [section('头版', 'headline', 2)],
  });
  assert.equal(created.statusCode, 201);
  const template = created.json() as { id: number; theme: { paper: string }; isDefault: boolean };
  assert.equal(template.theme.paper, DEFAULT_THEME.paper);
  assert.equal(template.isDefault, true);

  const duplicateNames = await write(app, 'POST', '/api/templates', {
    name: '坏模板',
    mastheadTitle: '接口报',
    sections: [section('同名', 'list', 2), section('同名', 'brief', 2)],
  });
  assert.equal(duplicateNames.statusCode, 400);
  assert.equal((duplicateNames.json() as { error: { code: string } }).error.code, 'E_VALIDATION');

  const badTheme = await write(app, 'POST', '/api/templates', {
    name: '坏主题',
    mastheadTitle: '接口报',
    theme: { ...DEFAULT_THEME, bodyFontSize: 99 },
    sections: [section('头版', 'headline', 2)],
  });
  assert.equal(badTheme.statusCode, 400);

  const copied = await write(app, 'POST', `/api/templates/${template.id}/copy`);
  assert.equal(copied.statusCode, 201);

  const previewResponse = await write(app, 'POST', '/api/issues/preview', { date: DATE });
  assert.equal(previewResponse.statusCode, 200);
  const previewBody = previewResponse.json() as { total: number; templateId: number };
  assert.equal(previewBody.total, 2);
  assert.equal(previewBody.templateId, template.id);

  const generated = await write(app, 'POST', '/api/issues/generate', { date: DATE });
  assert.equal(generated.statusCode, 201);
  const generatedBody = generated.json() as {
    generated: boolean;
    issue: { id: number; status: string; stats: { total: number } };
    preview: { total: number };
  };
  assert.equal(generatedBody.generated, true);
  assert.equal(generatedBody.issue.status, 'draft');
  assert.equal(generatedBody.issue.stats.total, 2);

  const conflict = await write(app, 'POST', '/api/issues/generate', { date: DATE });
  assert.equal(conflict.statusCode, 409);
  assert.equal((conflict.json() as { error: { code: string } }).error.code, 'E_DRAFT_EXISTS');

  const replaced = await write(app, 'POST', '/api/issues/generate', { date: DATE, replaceDraft: true });
  assert.equal(replaced.statusCode, 200);
  assert.equal((replaced.json() as { replacedDraft: boolean }).replacedDraft, true);

  const published = await write(app, 'POST', `/api/issues/${generatedBody.issue.id}/publish`);
  assert.equal(published.statusCode, 200);
  assert.equal((published.json() as { status: string }).status, 'published');

  const afterPublish = await write(app, 'POST', '/api/issues/generate', {
    date: DATE,
    replaceDraft: true,
  });
  assert.equal(afterPublish.statusCode, 409);
  assert.equal((afterPublish.json() as { error: { code: string } }).error.code, 'E_ISSUE_EXISTS');

  const badDate = await write(app, 'POST', '/api/issues/preview', { date: '2026-02-31' });
  assert.equal(badDate.statusCode, 400);
  assert.equal((badDate.json() as { error: { code: string } }).error.code, 'E_VALIDATION');

  const missingTemplate = await write(app, 'POST', '/api/issues/preview', { templateId: 9999 });
  assert.equal(missingTemplate.statusCode, 404);
  assert.equal((missingTemplate.json() as { error: { code: string } }).error.code, 'E_NOT_FOUND');

  await app.close();
  db.close();
});
