export const LAYOUT_TYPES = ['headline', 'feature', 'double', 'list', 'brief'] as const;
export type LayoutType = (typeof LAYOUT_TYPES)[number];

export const SOURCE_TYPES = ['rss', 'atom', 'webpage', 'manual'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CONTENT_ACCESS_LEVELS = ['link_only', 'metadata', 'user_provided', 'extracted'] as const;
export type ContentAccessLevel = (typeof CONTENT_ACCESS_LEVELS)[number];

export const ISSUE_STATUSES = ['draft', 'published', 'failed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const READING_STATUSES = ['unread', 'read', 'later'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const TEMPLATE_SORT_RULES = ['published_desc', 'source_priority', 'manual'] as const;
export type TemplateSortRule = (typeof TEMPLATE_SORT_RULES)[number];

export interface ThemeSettings {
  paper: string;
  paperTexture: 'plain' | 'grain';
  ink: string;
  inkMuted: string;
  rule: string;
  accent: string;
  bodyFontSize: number;
  bodyLineHeight: number;
  contentWidth: number;
}

export const DEFAULT_THEME: ThemeSettings = {
  paper: '#f3eee2',
  paperTexture: 'grain',
  ink: '#1c1a16',
  inkMuted: '#544d3d',
  rule: '#cabfa9',
  accent: '#8a2b1e',
  bodyFontSize: 17,
  bodyLineHeight: 1.85,
  contentWidth: 1180,
};

export interface ArticleCard {
  id: number;
  title: string;
  author: string | null;
  sourceId: number | null;
  sourceName: string | null;
  publishedAt: string | null;
  summary: string | null;
  imageUrl: string | null;
  originalUrl: string;
  accessLevel: ContentAccessLevel;
  readingStatus: ReadingStatus;
  /** 站内是否有可读正文；没有时卡片应提示“摘要 / 前往原文”，不要用阅读时长误导 */
  hasFullText: boolean;
  /** 预计阅读分钟数；正文缺失时按摘要估算，便于读者判断要不要点开 */
  readMinutes: number;
}

export interface ArticleDetail extends ArticleCard {
  canonicalUrl: string | null;
  discoveredAt: string;
  /** 系统摘要：来自 Feed 或抓取，不等于原文 */
  summaryIsSystem: boolean;
  /** 原文正文：只有在 content_access_level 为 user_provided / extracted 时才有 */
  contentText: string | null;
  note: string | null;
  /** 最近一次成功提取公开正文的时间；用户自己提供的正文不写这里 */
  extractedAt: string | null;
  /** 最近一次提取失败的原因；成功提取或手动保存正文后清空 */
  extractError: string | null;
}

export interface IssueSectionView {
  sectionId: number | null;
  name: string;
  layoutType: LayoutType;
  maxArticles: number;
  articles: ArticleCard[];
}

export interface IssueView {
  id: number;
  issueDate: string;
  issueNumber: number;
  status: IssueStatus;
  generatedAt: string;
  templateId: number | null;
  templateName: string | null;
  masthead: {
    title: string;
    subtitle: string;
    dateFormat: string;
  };
  theme: ThemeSettings;
  sections: IssueSectionView[];
  stats: {
    total: number;
    read: number;
    later: number;
  };
}

export interface IssueSummary {
  id: number;
  issueDate: string;
  issueNumber: number;
  status: IssueStatus;
  generatedAt: string;
  articleCount: number;
  mastheadTitle: string;
}

export interface SourceSummary {
  id: number;
  name: string;
  type: SourceType;
  url: string;
  siteUrl: string | null;
  enabled: boolean;
  pollIntervalMinutes: number;
  /** 采集到新文章后是否自动尝试提取公开正文；默认关闭 */
  extractContent: boolean;
  lastFetchedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  articleCount: number;
}

export interface FetchStats {
  inserted: number;
  duplicates: number;
  skipped: number;
  entryCount: number;
}

export interface SourceFetchResult extends FetchStats {
  sourceId: number;
  name: string;
  ok: boolean;
  status: 'ok' | 'not_modified' | 'error';
  feedTitle: string | null;
  error: string | null;
  errorCode: string | null;
  /** 本次采集后自动提取成功的新文章数（来源开启正文提取时才可能大于 0） */
  extracted: number;
}

export interface SourceCreateResult {
  source: SourceSummary;
  firstFetch: FetchStats;
}

export interface FetchAllResult {
  results: SourceFetchResult[];
  totals: { sources: number; ok: number; failed: number; inserted: number; duplicates: number };
}

export interface ArticleListPage {
  items: ArticleCard[];
  total: number;
  page: number;
  pageSize: number;
}

/** 单篇正文提取的结果。提取失败是预期内结果：文章仍保留标题、摘要和链接。 */
export interface ExtractionResult {
  ok: boolean;
  article: ArticleDetail;
  /** 保存下来的正文字符数（不含空白） */
  characters: number;
  /** 原文超长，只保存了前一段 */
  truncated: boolean;
  /** Readability 没读到内容，改用页面主区块兜底 */
  usedFallback: boolean;
  error: { code: string; message: string } | null;
}

/** 栏目筛选条件，存在 template_sections.filter_json */
export interface TemplateSectionFilter {
  /** 只看这些来源；为空表示所有启用来源 */
  sourceIds?: number[];
  /** 只看最近 N 天发布的文章；默认 7 天 */
  maxAgeDays?: number;
  /** 手动置顶的文章，按数组顺序排在栏目最前 */
  pinnedArticleIds?: number[];
}

export interface TemplateSectionInput {
  name: string;
  layoutType: LayoutType;
  maxArticles: number;
  filter: TemplateSectionFilter;
  sortRule: TemplateSortRule;
}

export interface TemplateSectionView extends TemplateSectionInput {
  id: number;
  sortOrder: number;
}

export interface TemplateView {
  id: number;
  name: string;
  mastheadTitle: string;
  subtitle: string;
  dateFormat: string;
  theme: ThemeSettings;
  /** 整期容量上限，存在 templates.layout_json */
  maxTotalArticles: number;
  isDefault: boolean;
  sections: TemplateSectionView[];
  updatedAt: string;
}

export interface IssuePreviewSection extends IssueSectionView {
  /** 通过栏目筛选的文章数（选入前） */
  matched: number;
  /** 因栏目或整期容量没排进去的篇数 */
  omitted: number;
}

export interface IssuePreview {
  issueDate: string;
  templateId: number;
  templateName: string;
  masthead: { title: string; subtitle: string; dateFormat: string };
  theme: ThemeSettings;
  maxTotalArticles: number;
  sections: IssuePreviewSection[];
  total: number;
  candidates: { fresh: number; used: number; eligible: number };
  existingIssue: { id: number; issueNumber: number; status: IssueStatus } | null;
  emptyReason: 'no_recent' | 'all_used' | 'filters' | null;
}

export interface IssueGenerateResult {
  generated: boolean;
  replacedDraft: boolean;
  issue: IssueView | null;
  preview: IssuePreview;
  reason: IssuePreview['emptyReason'];
}

/** 定时任务配置；存在 app_settings 表的 schedule 键里 */
export interface ScheduleSettings {
  enabled: boolean;
  /** 每天几点开始采集，本地时区的 HH:MM */
  collectTime: string;
  /** IANA 时区名，决定“今天”和 collectTime 的含义 */
  timeZone: string;
  /** 采集完成后自动按默认模板编排一期 */
  autoGenerate: boolean;
  /** 自动生成后直接出版；默认 false，先生成预览稿 */
  publish: boolean;
}

export const DEFAULT_SCHEDULE: ScheduleSettings = {
  enabled: true,
  collectTime: '07:00',
  timeZone: 'Asia/Shanghai',
  autoGenerate: true,
  publish: false,
};

export type JobTrigger = 'schedule' | 'manual';
export type JobStatus = 'running' | 'ok' | 'partial' | 'skipped' | 'failed';

export interface JobSourceResult extends SourceFetchResult {
  /** 实际请求次数（首次失败后会重试一次） */
  attempts: number;
}

export interface JobIssueResult {
  generated: boolean;
  issueId: number | null;
  issueStatus: IssueStatus | null;
  total: number;
  /** 没生成时的原因：空候选、已有草稿、已出版等 */
  reason: IssuePreview['emptyReason'] | 'draft_exists' | 'issue_exists' | 'error';
  message: string | null;
}

export interface JobRunDetail {
  sources: {
    total: number;
    ok: number;
    failed: number;
    inserted: number;
    duplicates: number;
    results: JobSourceResult[];
  } | null;
  issue: JobIssueResult | null;
  /** 面向人的一句话结果，失败原因也在这里 */
  note: string | null;
}

export interface JobRunSummary {
  id: number;
  trigger: JobTrigger;
  /** 任务归属的本地日期（YYYY-MM-DD），用于“一天只跑一次” */
  runDate: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  detail: JobRunDetail;
}

export interface SchedulerStatus {
  /** 进程内的定时循环是否已启动 */
  running: boolean;
  /** 下一次自动运行的时间；停用或无需运行时为 null */
  nextRunAt: string | null;
  localDate: string;
  localTime: string;
  /** 今天的定时任务记录（含被跳过的） */
  todayRun: JobRunSummary | null;
  /** 最近一次任务（定时或手动） */
  lastRun: JobRunSummary | null;
  recentRuns: JobRunSummary[];
}

export interface SettingsView {
  schedule: ScheduleSettings;
  /** 服务配置时区，用作新建配置的默认值 */
  serverTimeZone: string;
}

export interface BackupFile {
  file: string;
  bytes: number;
  createdAt: string;
  /** pre-migration 表示升级前自动备份，manual 表示用户手动备份 */
  kind: 'pre-migration' | 'manual';
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
