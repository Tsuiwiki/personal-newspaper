-- 001_init.sql — 初始数据模型（对应 PRD 第 8 节）
-- 约定：所有时间戳为 UTC ISO 8601 字符串；布尔用 0/1。

CREATE TABLE sources (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  type                  TEXT    NOT NULL CHECK (type IN ('rss', 'atom', 'webpage', 'manual')),
  url                   TEXT    NOT NULL,
  site_url              TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  poll_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (poll_interval_minutes BETWEEN 5 AND 10080),
  last_fetched_at       TEXT,
  last_status           TEXT,
  last_error            TEXT,
  etag                  TEXT,
  last_modified         TEXT,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_sources_url ON sources (url);
CREATE INDEX idx_sources_enabled ON sources (enabled);

CREATE TABLE articles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id             INTEGER REFERENCES sources (id) ON DELETE SET NULL,
  title                 TEXT    NOT NULL,
  author                TEXT,
  published_at          TEXT,
  discovered_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  canonical_url         TEXT,
  original_url          TEXT    NOT NULL,
  summary               TEXT,
  content_text          TEXT,
  content_html_sanitized TEXT,
  image_url             TEXT,
  content_hash          TEXT,
  content_access_level  TEXT    NOT NULL DEFAULT 'metadata'
                          CHECK (content_access_level IN ('link_only', 'metadata', 'user_provided', 'extracted')),
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 去重：canonical URL 与内容指纹各自唯一，标题不参与判重
CREATE UNIQUE INDEX idx_articles_canonical_url ON articles (canonical_url) WHERE canonical_url IS NOT NULL;
CREATE UNIQUE INDEX idx_articles_content_hash ON articles (content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX idx_articles_source ON articles (source_id);
CREATE INDEX idx_articles_published ON articles (published_at DESC);

CREATE TABLE templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  masthead_title TEXT    NOT NULL,
  subtitle       TEXT    NOT NULL DEFAULT '',
  date_format    TEXT    NOT NULL DEFAULT 'YYYY年M月D日 dddd',
  theme_json     TEXT    NOT NULL,
  layout_json    TEXT    NOT NULL DEFAULT '{}',
  is_default     INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE template_sections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id  INTEGER NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  layout_type  TEXT    NOT NULL CHECK (layout_type IN ('headline', 'feature', 'double', 'list', 'brief')),
  max_articles INTEGER NOT NULL DEFAULT 4 CHECK (max_articles BETWEEN 1 AND 30),
  filter_json  TEXT    NOT NULL DEFAULT '{}',
  sort_rule    TEXT    NOT NULL DEFAULT 'published_desc'
                          CHECK (sort_rule IN ('published_desc', 'source_priority', 'manual'))
);

CREATE INDEX idx_template_sections_template ON template_sections (template_id, sort_order);

CREATE TABLE issues (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_date             TEXT    NOT NULL,
  issue_number           INTEGER NOT NULL,
  template_id            INTEGER REFERENCES templates (id) ON DELETE SET NULL,
  template_snapshot_json TEXT    NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'failed')),
  generated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_issues_date_number ON issues (issue_date, issue_number);
CREATE INDEX idx_issues_date ON issues (issue_date DESC);

CREATE TABLE issue_articles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id              INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  article_id            INTEGER NOT NULL REFERENCES articles (id) ON DELETE RESTRICT,
  -- 指向 template_sections，但不设外键：栏目被删除后历史期刊仍要能读
  section_id            INTEGER,
  -- 版面快照：模板改动不影响已生成的期刊
  section_name          TEXT    NOT NULL,
  layout_type           TEXT    NOT NULL CHECK (layout_type IN ('headline', 'feature', 'double', 'list', 'brief')),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  display_snapshot_json TEXT    NOT NULL DEFAULT '{}',
  UNIQUE (issue_id, article_id)
);

CREATE INDEX idx_issue_articles_issue ON issue_articles (issue_id, section_id, sort_order);

CREATE TABLE reading_states (
  article_id INTEGER PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  status     TEXT    NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'later')),
  progress   REAL    CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  note       TEXT,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_reading_states_status ON reading_states (status);
