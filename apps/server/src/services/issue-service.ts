import {
  DEFAULT_THEME,
  themeSchema,
  type ArticleCard,
  type ContentAccessLevel,
  type IssueSectionView,
  type IssueSummary,
  type IssueView,
  type LayoutType,
  type ReadingStatus,
  type TemplateSectionFilter,
  type TemplateSortRule,
  type ThemeSettings,
} from '@paper/shared';
import type { Db } from '../db/index.js';

export interface TemplateSectionSnapshot {
  id: number | null;
  name: string;
  layoutType: LayoutType;
  maxArticles: number;
  filter?: TemplateSectionFilter;
  sortRule?: TemplateSortRule;
}

export interface TemplateSnapshot {
  templateName: string;
  masthead: { title: string; subtitle: string; dateFormat: string };
  theme: ThemeSettings;
  /** 生成当时的整期容量，仅供追溯；渲染不依赖它 */
  maxTotalArticles?: number;
  sections: TemplateSectionSnapshot[];
}

interface IssueRow {
  id: number;
  issue_date: string;
  issue_number: number;
  template_id: number | null;
  template_snapshot_json: string;
  status: 'draft' | 'published' | 'failed';
  generated_at: string;
}

interface IssueArticleRow {
  section_id: number | null;
  section_name: string;
  layout_type: LayoutType;
  sort_order: number;
  article_id: number;
  title: string;
  author: string | null;
  published_at: string | null;
  summary: string | null;
  image_url: string | null;
  original_url: string;
  content_text: string | null;
  content_access_level: ContentAccessLevel;
  source_id: number | null;
  source_name: string | null;
  reading_status: ReadingStatus | null;
}

export function estimateReadMinutes(text: string | null, summary: string | null): number {
  const source = text ?? summary ?? '';
  const chars = source.replace(/\s+/g, '').length;
  if (chars === 0) return 1;
  return Math.max(1, Math.round(chars / 400));
}

/** 快照来自数据库，属于边界数据：解析失败时回退到默认值，不能让一期报纸打不开 */
export function parseTemplateSnapshot(raw: string): TemplateSnapshot {
  const fallback: TemplateSnapshot = {
    templateName: '未命名模板',
    masthead: { title: '个人数字报纸', subtitle: '', dateFormat: 'YYYY年M月D日 dddd' },
    theme: DEFAULT_THEME,
    sections: [],
  };
  try {
    const parsed = JSON.parse(raw) as Partial<TemplateSnapshot>;
    const theme = themeSchema.safeParse(parsed.theme);
    return {
      templateName: parsed.templateName ?? fallback.templateName,
      masthead: { ...fallback.masthead, ...(parsed.masthead ?? {}) },
      theme: theme.success ? theme.data : DEFAULT_THEME,
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    };
  } catch {
    return fallback;
  }
}

function toCard(row: IssueArticleRow): ArticleCard {
  return {
    id: row.article_id,
    title: row.title,
    author: row.author,
    sourceId: row.source_id,
    sourceName: row.source_name,
    publishedAt: row.published_at,
    summary: row.summary,
    imageUrl: row.image_url,
    originalUrl: row.original_url,
    accessLevel: row.content_access_level,
    readingStatus: row.reading_status ?? 'unread',
    hasFullText: Boolean(row.content_text),
    readMinutes: estimateReadMinutes(row.content_text, row.summary),
  };
}

const ISSUE_ARTICLE_SQL = `
  SELECT
    ia.section_id,
    ia.section_name,
    ia.layout_type,
    ia.sort_order,
    a.id AS article_id,
    a.title,
    a.author,
    a.published_at,
    a.summary,
    a.image_url,
    a.original_url,
    a.content_text,
    a.content_access_level,
    s.id AS source_id,
    s.name AS source_name,
    rs.status AS reading_status
  FROM issue_articles ia
  JOIN articles a ON a.id = ia.article_id
  LEFT JOIN sources s ON s.id = a.source_id
  LEFT JOIN reading_states rs ON rs.article_id = a.id
  WHERE ia.issue_id = ?
  ORDER BY ia.sort_order ASC
`;

function buildSections(snapshot: TemplateSnapshot, rows: IssueArticleRow[]): IssueSectionView[] {
  const byKey = new Map<string, IssueArticleRow[]>();
  for (const row of rows) {
    const key = `${row.section_name}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  const sections: IssueSectionView[] = snapshot.sections.map((section) => ({
    sectionId: section.id,
    name: section.name,
    layoutType: section.layoutType,
    maxArticles: section.maxArticles,
    articles: (byKey.get(section.name) ?? []).map(toCard),
  }));

  // 快照里没有的栏目（例如快照被手改过）也要显示，不能吞掉文章
  for (const [name, sectionRows] of byKey) {
    if (sections.some((section) => section.name === name)) continue;
    const first = sectionRows[0]!;
    sections.push({
      sectionId: first.section_id,
      name,
      layoutType: first.layout_type,
      maxArticles: sectionRows.length,
      articles: sectionRows.map(toCard),
    });
  }

  return sections.filter((section) => section.articles.length > 0);
}

export function toIssueView(db: Db, row: IssueRow): IssueView {
  const snapshot = parseTemplateSnapshot(row.template_snapshot_json);
  const articleRows = db.prepare(ISSUE_ARTICLE_SQL).all(row.id) as IssueArticleRow[];
  const sections = buildSections(snapshot, articleRows);
  const cards = sections.flatMap((section) => section.articles);

  return {
    id: row.id,
    issueDate: row.issue_date,
    issueNumber: row.issue_number,
    status: row.status,
    generatedAt: row.generated_at,
    templateId: row.template_id,
    templateName: snapshot.templateName,
    masthead: snapshot.masthead,
    theme: snapshot.theme,
    sections,
    stats: {
      total: cards.length,
      read: cards.filter((card) => card.readingStatus === 'read').length,
      later: cards.filter((card) => card.readingStatus === 'later').length,
    },
  };
}

export function getLatestIssueRow(db: Db): IssueRow | null {
  const row = db
    .prepare(
      `SELECT * FROM issues
       WHERE status IN ('published', 'draft')
       ORDER BY issue_date DESC, id DESC
       LIMIT 1`,
    )
    .get() as IssueRow | undefined;
  return row ?? null;
}

export function getIssueRow(db: Db, id: number): IssueRow | null {
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as IssueRow | undefined;
  return row ?? null;
}

export function getLatestIssue(db: Db): IssueView | null {
  const row = getLatestIssueRow(db);
  return row ? toIssueView(db, row) : null;
}

export function listIssues(db: Db): IssueSummary[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.issue_date, i.issue_number, i.status, i.generated_at, i.template_snapshot_json,
              (SELECT COUNT(*) FROM issue_articles ia WHERE ia.issue_id = i.id) AS article_count
       FROM issues i
       ORDER BY i.issue_date DESC, i.id DESC`,
    )
    .all() as Array<{
    id: number;
    issue_date: string;
    issue_number: number;
    status: IssueSummary['status'];
    generated_at: string;
    template_snapshot_json: string;
    article_count: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    issueDate: row.issue_date,
    issueNumber: row.issue_number,
    status: row.status,
    generatedAt: row.generated_at,
    articleCount: row.article_count,
    mastheadTitle: parseTemplateSnapshot(row.template_snapshot_json).masthead.title,
  }));
}
