-- 002_article_external_id.sql — Feed 条目稳定 ID
-- 用于同一来源内的去重：guid / Atom id 比重写过的链接更可靠。
ALTER TABLE articles ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX idx_articles_source_external
  ON articles (source_id, external_id)
  WHERE external_id IS NOT NULL;
