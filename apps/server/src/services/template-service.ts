import {
  DEFAULT_THEME,
  TEMPLATE_SORT_RULES,
  themeSchema,
  type LayoutType,
  type TemplateSectionFilter,
  type TemplateSectionInput,
  type TemplateSectionView,
  type TemplateSortRule,
  type TemplateView,
  type ThemeSettings,
} from '@paper/shared';
import type { Db } from '../db/index.js';
import { ApiError, notFound } from '../errors.js';

export const DEFAULT_MAX_TOTAL_ARTICLES = 15;

interface TemplateRow {
  id: number;
  name: string;
  masthead_title: string;
  subtitle: string;
  date_format: string;
  theme_json: string;
  layout_json: string;
  is_default: number;
  updated_at: string;
}

interface SectionRow {
  id: number;
  template_id: number;
  name: string;
  sort_order: number;
  layout_type: LayoutType;
  max_articles: number;
  filter_json: string;
  sort_rule: TemplateSortRule;
}

export interface TemplateInput {
  name: string;
  mastheadTitle: string;
  subtitle: string;
  dateFormat: string;
  theme: ThemeSettings;
  maxTotalArticles: number;
  sections: TemplateSectionInput[];
}

export type TemplatePatch = Partial<TemplateInput>;

export function getTemplateRow(db: Db, id: number): TemplateRow | null {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
  return row ?? null;
}

export function getDefaultTemplateRow(db: Db): TemplateRow | null {
  const row = db
    .prepare('SELECT * FROM templates ORDER BY is_default DESC, id ASC LIMIT 1')
    .get() as TemplateRow | undefined;
  return row ?? null;
}

/** 快照与 filter_json 都来自数据库，解析失败时退回安全默认值 */
export function parseTheme(raw: string): ThemeSettings {
  try {
    const parsed = themeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function parseMaxTotalArticles(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { maxTotalArticles?: unknown };
    const value = parsed?.maxTotalArticles;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 50
      ? value
      : DEFAULT_MAX_TOTAL_ARTICLES;
  } catch {
    return DEFAULT_MAX_TOTAL_ARTICLES;
  }
}

function positiveIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter(
    (item): item is number => typeof item === 'number' && Number.isInteger(item) && item > 0,
  );
  return ids.length > 0 ? ids.slice(0, 50) : undefined;
}

export function parseSectionFilter(raw: string): TemplateSectionFilter {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const filter: TemplateSectionFilter = {};
    const sourceIds = positiveIds(parsed['sourceIds']);
    if (sourceIds) filter.sourceIds = sourceIds;
    const pinned = positiveIds(parsed['pinnedArticleIds']);
    if (pinned) filter.pinnedArticleIds = pinned;
    const maxAgeDays = parsed['maxAgeDays'];
    if (typeof maxAgeDays === 'number' && Number.isInteger(maxAgeDays) && maxAgeDays >= 1 && maxAgeDays <= 365) {
      filter.maxAgeDays = maxAgeDays;
    }
    return filter;
  } catch {
    return {};
  }
}

function parseSortRule(value: string): TemplateSortRule {
  return (TEMPLATE_SORT_RULES as readonly string[]).includes(value)
    ? (value as TemplateSortRule)
    : 'published_desc';
}

function toSectionView(row: SectionRow): TemplateSectionView {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    layoutType: row.layout_type,
    maxArticles: row.max_articles,
    filter: parseSectionFilter(row.filter_json),
    sortRule: parseSortRule(row.sort_rule),
  };
}

function toView(row: TemplateRow, sections: SectionRow[]): TemplateView {
  return {
    id: row.id,
    name: row.name,
    mastheadTitle: row.masthead_title,
    subtitle: row.subtitle,
    dateFormat: row.date_format,
    theme: parseTheme(row.theme_json),
    maxTotalArticles: parseMaxTotalArticles(row.layout_json),
    isDefault: row.is_default === 1,
    sections: sections.filter((section) => section.template_id === row.id).map(toSectionView),
    updatedAt: row.updated_at,
  };
}

export function getTemplateView(db: Db, id: number): TemplateView | null {
  const row = getTemplateRow(db, id);
  if (!row) return null;
  const sections = db
    .prepare('SELECT * FROM template_sections WHERE template_id = ? ORDER BY sort_order ASC, id ASC')
    .all(id) as SectionRow[];
  return toView(row, sections);
}

export function listTemplates(db: Db): TemplateView[] {
  const rows = db
    .prepare('SELECT * FROM templates ORDER BY is_default DESC, id ASC')
    .all() as TemplateRow[];
  const sections = db
    .prepare('SELECT * FROM template_sections ORDER BY template_id ASC, sort_order ASC, id ASC')
    .all() as SectionRow[];
  return rows.map((row) => toView(row, sections));
}

function insertSections(db: Db, templateId: number, sections: TemplateSectionInput[]): void {
  const insert = db.prepare(
    `INSERT INTO template_sections
       (template_id, name, sort_order, layout_type, max_articles, filter_json, sort_rule)
     VALUES (@templateId, @name, @sortOrder, @layoutType, @maxArticles, @filterJson, @sortRule)`,
  );
  sections.forEach((section, index) => {
    insert.run({
      templateId,
      name: section.name,
      sortOrder: index,
      layoutType: section.layoutType,
      maxArticles: section.maxArticles,
      filterJson: JSON.stringify(section.filter ?? {}),
      sortRule: section.sortRule,
    });
  });
}

export function createTemplate(db: Db, input: TemplateInput): TemplateView {
  const hasDefault = db.prepare('SELECT 1 AS ok FROM templates WHERE is_default = 1').get();
  const create = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO templates
           (name, masthead_title, subtitle, date_format, theme_json, layout_json, is_default)
         VALUES
           (@name, @mastheadTitle, @subtitle, @dateFormat, @themeJson, @layoutJson, @isDefault)`,
      )
      .run({
        name: input.name,
        mastheadTitle: input.mastheadTitle,
        subtitle: input.subtitle,
        dateFormat: input.dateFormat,
        themeJson: JSON.stringify(input.theme),
        layoutJson: JSON.stringify({ maxTotalArticles: input.maxTotalArticles }),
        isDefault: hasDefault ? 0 : 1,
      });
    const id = Number(info.lastInsertRowid);
    insertSections(db, id, input.sections);
    return id;
  });

  const id = create();
  return getTemplateView(db, id)!;
}

export function copyTemplate(db: Db, id: number): TemplateView {
  const source = getTemplateView(db, id);
  if (!source) throw notFound('这个模板不存在');

  const base = `${source.name.slice(0, 46)} 副本`;
  let name = base;
  let suffix = 2;
  while (db.prepare('SELECT 1 AS ok FROM templates WHERE name = ?').get(name)) {
    name = `${source.name.slice(0, 42)} 副本 ${suffix}`;
    suffix += 1;
  }

  return createTemplate(db, {
    name,
    mastheadTitle: source.mastheadTitle,
    subtitle: source.subtitle,
    dateFormat: source.dateFormat,
    theme: source.theme,
    maxTotalArticles: source.maxTotalArticles,
    sections: source.sections.map(({ name: sectionName, layoutType, maxArticles, filter, sortRule }) => ({
      name: sectionName,
      layoutType,
      maxArticles,
      filter,
      sortRule,
    })),
  });
}

export function updateTemplate(db: Db, id: number, patch: TemplatePatch): TemplateView {
  const row = getTemplateRow(db, id);
  if (!row) throw notFound('这个模板不存在');
  if (patch.sections && patch.sections.length === 0) {
    throw new ApiError(400, 'E_VALIDATION', '至少需要保留一个栏目');
  }

  const theme = patch.theme ?? parseTheme(row.theme_json);
  const maxTotalArticles = patch.maxTotalArticles ?? parseMaxTotalArticles(row.layout_json);

  const update = db.transaction(() => {
    db.prepare(
      `UPDATE templates SET
         name = @name,
         masthead_title = @mastheadTitle,
         subtitle = @subtitle,
         date_format = @dateFormat,
         theme_json = @themeJson,
         layout_json = @layoutJson,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id`,
    ).run({
      id,
      name: patch.name ?? row.name,
      mastheadTitle: patch.mastheadTitle ?? row.masthead_title,
      subtitle: patch.subtitle ?? row.subtitle,
      dateFormat: patch.dateFormat ?? row.date_format,
      themeJson: JSON.stringify(theme),
      layoutJson: JSON.stringify({ maxTotalArticles }),
    });

    if (patch.sections) {
      db.prepare('DELETE FROM template_sections WHERE template_id = ?').run(id);
      insertSections(db, id, patch.sections);
    }
  });
  update();

  return getTemplateView(db, id)!;
}

export function setDefaultTemplate(db: Db, id: number): TemplateView {
  const row = getTemplateRow(db, id);
  if (!row) throw notFound('这个模板不存在');

  db.transaction(() => {
    db.prepare('UPDATE templates SET is_default = 0 WHERE is_default = 1').run();
    db.prepare(
      "UPDATE templates SET is_default = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(id);
  })();

  return getTemplateView(db, id)!;
}
