import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createPublishedSnapshot, publicUrl, withBase } from './export-site.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE issues (id INTEGER, issue_date TEXT, issue_number INTEGER, template_snapshot_json TEXT, status TEXT);
    CREATE TABLE sources (id INTEGER, name TEXT, url TEXT);
    CREATE TABLE articles (id INTEGER, source_id INTEGER, title TEXT, author TEXT, summary TEXT,
      image_url TEXT, published_at TEXT, original_url TEXT, content_text TEXT, content_access_level TEXT);
    CREATE TABLE issue_articles (id INTEGER, issue_id INTEGER, article_id INTEGER, section_name TEXT,
      layout_type TEXT, sort_order INTEGER, display_snapshot_json TEXT);
    CREATE TABLE reading_states (article_id INTEGER, status TEXT, note TEXT, progress REAL);
    INSERT INTO sources VALUES (1, '来源名称', 'https://example.com/feed?token=PRIVATE_FEED_TOKEN');
    INSERT INTO articles VALUES (1, 1, '现在的标题', '作者', '现在的摘要', NULL, NULL,
      'https://example.com/article', '允许导出的正文', 'user_provided');
    INSERT INTO articles VALUES (2, 1, 'PRIVATE_DRAFT', NULL, NULL, NULL, NULL, 'https://example.com/draft', 'PRIVATE_BODY', 'user_provided');
    INSERT INTO articles VALUES (3, 1, 'PRIVATE_UNSELECTED', NULL, NULL, NULL, NULL, 'https://example.com/unused', NULL, 'metadata');
    INSERT INTO issues VALUES (1, '2026-10-28', 1, '{}', 'published');
    INSERT INTO issues VALUES (2, '2026-10-29', 1, '{}', 'draft');
    INSERT INTO issue_articles VALUES (1, 1, 1, '历史栏目', 'feature', 1,
      '{"title":"出版时标题","summary":"出版时摘要","sourceName":"出版时来源","note":"PRIVATE_SNAPSHOT_FIELD"}');
    INSERT INTO issue_articles VALUES (2, 2, 2, '草稿栏目', 'list', 1, '{}');
    INSERT INTO reading_states VALUES (1, 'later', 'PRIVATE_PERSONAL_NOTE', 0.75);
  `);
  return db;
}

test('only published selections and allowlisted fields are exported without modifying the database', () => {
  const db = fixture();
  try {
    const before = db.serialize();
    const result = createPublishedSnapshot(db);
    assert.deepEqual(db.serialize(), before);
    assert.equal(result.issues.length, 1);
    const section = result.issues[0]!.sections[0]!;
    assert.equal(section.name, '历史栏目');
    assert.equal(section.layoutType, 'feature');
    assert.equal(section.articles.length, 1);
    assert.equal(section.articles[0]!.title, '出版时标题');
    assert.equal(section.articles[0]!.summary, '出版时摘要');
    assert.equal(section.articles[0]!.sourceName, '出版时来源');
    assert.equal(section.articles[0]!.contentText, '允许导出的正文');
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /PRIVATE_|readingStatus|sourceId|progress|"note"|token=/);
  } finally { db.close(); }
});

test('empty publication stops export; non-body access levels do not export text', () => {
  const db = fixture();
  try {
    db.exec("UPDATE articles SET content_access_level = 'metadata' WHERE id = 1");
    assert.equal(createPublishedSnapshot(db).issues[0]!.sections[0]!.articles[0]!.contentText, null);
    db.exec("UPDATE issues SET status = 'draft'");
    assert.throws(() => createPublishedSnapshot(db), /没有已出版/);
  } finally { db.close(); }
});

test('placeholder, credential-bearing, local and unsafe links are not published', () => {
  for (const url of ['javascript:alert(1)', 'https://example.local/read/a', 'http://127.0.0.1/a',
    'http://[::1]/a', 'https://img.example.invalid/x', 'https://name:pass@example.com/a',
    'https://example.com/feed?token=SECRET', 'https://example.com/a?X-Amz-Credential=SECRET']) {
    assert.equal(publicUrl(url), '');
  }
  assert.equal(publicUrl('https://example.com/article#heading'), 'https://example.com/article');
});

test('subpath deployment moves local images under the base and leaves external ones alone', () => {
  const db = fixture();
  try {
    db.exec("UPDATE articles SET image_url = '/media/card-notes.svg' WHERE id = 1");
    db.exec("UPDATE issue_articles SET display_snapshot_json = '{}' WHERE issue_id = 1");
    const root = createPublishedSnapshot(db);
    const hosted = withBase(root, '/personal-newspaper/');
    const card = hosted.issues[0]!.sections[0]!.articles[0]!;
    assert.equal(card.imageUrl, '/personal-newspaper/media/card-notes.svg');
    assert.equal(root.issues[0]!.sections[0]!.articles[0]!.imageUrl, '/media/card-notes.svg');
    assert.equal(withBase(root, '/'), root);
  } finally { db.close(); }
});
