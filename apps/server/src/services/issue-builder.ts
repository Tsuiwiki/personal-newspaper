import type {
  ArticleCard,
  ContentAccessLevel,
  IssueGenerateResult,
  IssuePreview,
  IssuePreviewSection,
  IssueView,
  ReadingStatus,
  TemplateSectionFilter,
  TemplateSortRule,
  TemplateView,
} from '@paper/shared';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { ApiError, notFound } from '../errors.js';
import { DAY_MS, addDays, todayInTimeZone, zonedMidnightUtc } from '../time.js';
import { estimateReadMinutes, getIssueRow, toIssueView, type TemplateSnapshot } from './issue-service.js';
import {
  getDefaultTemplateRow,
  getTemplateRow,
  getTemplateView,
} from './template-service.js';

const DEFAULT_SECTION_AGE_DAYS = 7;

export { todayInTimeZone, zonedMidnightUtc };

interface CandidateRow {
  id: number;
  source_id: number | null;
  title: string;
  author: string | null;
  published_at: string | null;
  discovered_at: string;
  summary: string | null;
  image_url: string | null;
  original_url: string;
  content_text: string | null;
  content_access_level: ContentAccessLevel;
  source_name: string | null;
  reading_status: ReadingStatus | null;
  effective_at: string;
}

interface ExistingIssueRow {
  id: number;
  issue_number: number;
  status: 'draft' | 'published' | 'failed';
}

export interface IssueBuildOptions {
  date?: string;
  templateId?: number;
  timeZone?: string;
  /** 测试用：固定“今天” */
  now?: Date;
}

export interface IssueGenerateOptions extends IssueBuildOptions {
  replaceDraft?: boolean;
  publish?: boolean;
}

function windowBounds(date: string, days: number, timeZone: string): { start: string; end: string } {
  const end = zonedMidnightUtc(addDays(date, 1), timeZone);
  return { start: new Date(end - days * DAY_MS).toISOString(), end: new Date(end).toISOString() };
}

function sectionAgeDays(filter: TemplateSectionFilter): number {
  return filter.maxAgeDays ?? DEFAULT_SECTION_AGE_DAYS;
}

function effectiveTime(row: CandidateRow): number {
  return new Date(row.effective_at).getTime();
}

function toCard(row: CandidateRow): ArticleCard {
  return {
    id: row.id,
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

function findExistingIssue(db: Db, date: string): ExistingIssueRow | null {
  const row = db
    .prepare(
      `SELECT id, issue_number, status FROM issues
       WHERE issue_date = ? AND issue_number = 1`,
    )
    .get(date) as ExistingIssueRow | undefined;
  return row ?? null;
}

/**
 * 候选池：启用来源（以及手动添加、没有来源的文章）+ 时间窗口内 + 没被别的期刊用过。
 * 正在重新生成的那一期不算“用过”，否则替换草稿会永远选不到文章。
 */
function loadCandidates(
  db: Db,
  bounds: { start: string; end: string },
  excludeIssueId: number,
): CandidateRow[] {
  return db
    .prepare(
      `SELECT
         a.id, a.source_id, a.title, a.author, a.published_at, a.discovered_at, a.summary,
         a.image_url, a.original_url, a.content_text, a.content_access_level,
         s.name AS source_name,
         rs.status AS reading_status,
         COALESCE(a.published_at, a.discovered_at) AS effective_at
       FROM articles a
       LEFT JOIN sources s ON s.id = a.source_id
       LEFT JOIN reading_states rs ON rs.article_id = a.id
       WHERE (a.source_id IS NULL OR s.enabled = 1)
         AND julianday(COALESCE(a.published_at, a.discovered_at)) >= julianday(@start)
         AND julianday(COALESCE(a.published_at, a.discovered_at)) < julianday(@end)
         AND NOT EXISTS (
           SELECT 1 FROM issue_articles ia
           WHERE ia.article_id = a.id AND ia.issue_id <> @excludeIssueId
         )
       ORDER BY julianday(COALESCE(a.published_at, a.discovered_at)) DESC, a.id DESC`,
    )
    .all({ ...bounds, excludeIssueId }) as CandidateRow[];
}

function countUsedInWindow(
  db: Db,
  bounds: { start: string; end: string },
  excludeIssueId: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM articles a
       LEFT JOIN sources s ON s.id = a.source_id
       WHERE (a.source_id IS NULL OR s.enabled = 1)
         AND julianday(COALESCE(a.published_at, a.discovered_at)) >= julianday(@start)
         AND julianday(COALESCE(a.published_at, a.discovered_at)) < julianday(@end)
         AND EXISTS (
           SELECT 1 FROM issue_articles ia
           WHERE ia.article_id = a.id AND ia.issue_id <> @excludeIssueId
         )`,
    )
    .get({ ...bounds, excludeIssueId }) as { n: number };
  return row.n;
}

function sortForSection(
  rows: CandidateRow[],
  filter: TemplateSectionFilter,
  sortRule: TemplateSortRule,
): CandidateRow[] {
  const sorted = [...rows];
  if (sortRule === 'source_priority' && filter.sourceIds && filter.sourceIds.length > 0) {
    const priority = new Map(filter.sourceIds.map((id, index) => [id, index]));
    sorted.sort((a, b) => {
      const pa = a.source_id === null ? Number.MAX_SAFE_INTEGER : (priority.get(a.source_id) ?? Number.MAX_SAFE_INTEGER - 1);
      const pb = b.source_id === null ? Number.MAX_SAFE_INTEGER : (priority.get(b.source_id) ?? Number.MAX_SAFE_INTEGER - 1);
      if (pa !== pb) return pa - pb;
      return effectiveTime(b) - effectiveTime(a) || b.id - a.id;
    });
  }
  if (filter.pinnedArticleIds && filter.pinnedArticleIds.length > 0) {
    const pinned = new Map(filter.pinnedArticleIds.map((id, index) => [id, index]));
    sorted.sort((a, b) => {
      const pa = pinned.get(a.id);
      const pb = pinned.get(b.id);
      if (pa !== undefined && pb !== undefined) return pa - pb;
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return 0;
    });
  }
  return sorted;
}

function acquireTemplate(db: Db, templateId?: number): TemplateView {
  const row = templateId ? getTemplateRow(db, templateId) : getDefaultTemplateRow(db);
  if (!row) {
    if (templateId) throw notFound('这个模板不存在');
    throw new ApiError(409, 'E_NO_TEMPLATE', '还没有可用模板，请先在模板编辑器里建一个');
  }
  return getTemplateView(db, row.id)!;
}

export function buildIssuePreview(db: Db, options: IssueBuildOptions = {}): IssuePreview {
  const timeZone = options.timeZone ?? config.timezone;
  const date = options.date ?? todayInTimeZone(timeZone, options.now);
  const template = acquireTemplate(db, options.templateId);
  const existing = findExistingIssue(db, date);
  const excludeIssueId = existing?.id ?? 0;

  const globalDays = Math.max(
    DEFAULT_SECTION_AGE_DAYS,
    ...template.sections.map((section) => sectionAgeDays(section.filter)),
  );
  const globalBounds = windowBounds(date, globalDays, timeZone);
  const candidates = loadCandidates(db, globalBounds, excludeIssueId);
  const used = countUsedInWindow(db, globalBounds, excludeIssueId);

  const selectedIds = new Set<number>();
  let selectedTotal = 0;
  const sections: IssuePreviewSection[] = [];

  for (const section of template.sections) {
    const sourceIds = section.filter.sourceIds;
    const sourceSet = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;
    const bounds = windowBounds(date, sectionAgeDays(section.filter), timeZone);
    const start = new Date(bounds.start).getTime();
    const end = new Date(bounds.end).getTime();

    const matched = candidates.filter((row) => {
      if (sourceSet && (row.source_id === null || !sourceSet.has(row.source_id))) return false;
      const at = effectiveTime(row);
      return at >= start && at < end;
    });
    const ordered = sortForSection(matched, section.filter, section.sortRule);

    const picked: CandidateRow[] = [];
    const remaining = template.maxTotalArticles - selectedTotal;
    for (const row of ordered) {
      if (picked.length >= section.maxArticles || picked.length >= remaining) break;
      if (selectedIds.has(row.id)) continue;
      picked.push(row);
      selectedIds.add(row.id);
    }
    selectedTotal += picked.length;

    sections.push({
      sectionId: section.id,
      name: section.name,
      layoutType: section.layoutType,
      maxArticles: section.maxArticles,
      articles: picked.map(toCard),
      matched: matched.length,
      omitted: matched.length - picked.length,
    });
  }

  const total = sections.reduce((sum, section) => sum + section.articles.length, 0);
  let emptyReason: IssuePreview['emptyReason'] = null;
  if (total === 0) {
    if (candidates.length === 0) emptyReason = used > 0 ? 'all_used' : 'no_recent';
    else emptyReason = 'filters';
  }

  return {
    issueDate: date,
    templateId: template.id,
    templateName: template.name,
    masthead: {
      title: template.mastheadTitle,
      subtitle: template.subtitle,
      dateFormat: template.dateFormat,
    },
    theme: template.theme,
    maxTotalArticles: template.maxTotalArticles,
    sections,
    total,
    candidates: { fresh: candidates.length + used, used, eligible: candidates.length },
    existingIssue: existing
      ? { id: existing.id, issueNumber: existing.issue_number, status: existing.status }
      : null,
    emptyReason,
  };
}

function buildSnapshot(template: TemplateView): TemplateSnapshot {
  return {
    templateName: template.name,
    masthead: {
      title: template.mastheadTitle,
      subtitle: template.subtitle,
      dateFormat: template.dateFormat,
    },
    theme: template.theme,
    maxTotalArticles: template.maxTotalArticles,
    sections: template.sections.map((section) => ({
      id: section.id,
      name: section.name,
      layoutType: section.layoutType,
      maxArticles: section.maxArticles,
      filter: section.filter,
      sortRule: section.sortRule,
    })),
  };
}

export function generateIssue(db: Db, options: IssueGenerateOptions = {}): IssueGenerateResult {
  const preview = buildIssuePreview(db, options);
  const existing = preview.existingIssue;

  if (existing) {
    if (existing.status === 'published') {
      throw new ApiError(409, 'E_ISSUE_EXISTS', '今天这一期已经出版，不能静默覆盖', {
        issueId: existing.id,
      });
    }
    if (existing.status === 'failed') {
      throw new ApiError(409, 'E_ISSUE_FAILED', '今天这一期上次生成失败，请先处理它', {
        issueId: existing.id,
      });
    }
    if (!options.replaceDraft) {
      throw new ApiError(409, 'E_DRAFT_EXISTS', '今天已有一份预览稿，确认后可以替换', {
        issueId: existing.id,
      });
    }
  }

  if (preview.total === 0) {
    return {
      generated: false,
      replacedDraft: false,
      issue: null,
      preview,
      reason: preview.emptyReason,
    };
  }

  const template = getTemplateView(db, preview.templateId)!;
  const snapshot = JSON.stringify(buildSnapshot(template));
  const status = options.publish ? 'published' : 'draft';
  const generatedAt = new Date().toISOString();

  const save = db.transaction(() => {
    let issueId: number;
    if (existing) {
      issueId = existing.id;
      db.prepare(
        `UPDATE issues
         SET template_id = @templateId,
             template_snapshot_json = @snapshot,
             status = @status,
             generated_at = @generatedAt
         WHERE id = @issueId`,
      ).run({ issueId, templateId: template.id, snapshot, status, generatedAt });
      db.prepare('DELETE FROM issue_articles WHERE issue_id = ?').run(issueId);
    } else {
      const info = db
        .prepare(
          `INSERT INTO issues
             (issue_date, issue_number, template_id, template_snapshot_json, status, generated_at)
           VALUES
             (@date, 1, @templateId, @snapshot, @status, @generatedAt)`,
        )
        .run({ date: preview.issueDate, templateId: template.id, snapshot, status, generatedAt });
      issueId = Number(info.lastInsertRowid);
    }

    const insert = db.prepare(
      `INSERT INTO issue_articles
         (issue_id, article_id, section_id, section_name, layout_type, sort_order, display_snapshot_json)
       VALUES
         (@issueId, @articleId, @sectionId, @sectionName, @layoutType, @sortOrder, @displaySnapshot)`,
    );
    let sortOrder = 0;
    for (const section of preview.sections) {
      for (const article of section.articles) {
        insert.run({
          issueId,
          articleId: article.id,
          sectionId: section.sectionId,
          sectionName: section.name,
          layoutType: section.layoutType,
          sortOrder: sortOrder++,
          displaySnapshot: JSON.stringify({
            title: article.title,
            author: article.author,
            sourceName: article.sourceName,
            summary: article.summary,
            imageUrl: article.imageUrl,
            publishedAt: article.publishedAt,
          }),
        });
      }
    }
    return issueId;
  });

  const issueId = save();
  const issue = toIssueView(db, getIssueRow(db, issueId)!);
  return {
    generated: true,
    replacedDraft: Boolean(existing),
    issue,
    preview,
    reason: null,
  };
}

export function publishIssue(db: Db, id: number): IssueView {
  const row = getIssueRow(db, id);
  if (!row) throw notFound('这一期期刊不存在');
  if (row.status === 'failed') {
    throw new ApiError(409, 'E_ISSUE_FAILED', '这一期生成失败了，不能出版');
  }
  if (row.status === 'draft') {
    db.prepare("UPDATE issues SET status = 'published' WHERE id = ?").run(id);
  }
  return toIssueView(db, getIssueRow(db, id)!);
}
