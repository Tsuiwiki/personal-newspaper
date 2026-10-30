-- 004_content_extraction.sql — 公开页面正文提取（对应 PRD 6.2 / 7.3 content-extractor）
-- 存储策略按来源配置，默认关闭；只有用户显式开启或对单篇手动提取时才读取原文页面。

ALTER TABLE sources
  ADD COLUMN extract_content INTEGER NOT NULL DEFAULT 0 CHECK (extract_content IN (0, 1));

ALTER TABLE articles
  ADD COLUMN extracted_at TEXT;

ALTER TABLE articles
  ADD COLUMN extract_error TEXT;
