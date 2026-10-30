import { z } from 'zod';
import {
  CONTENT_ACCESS_LEVELS,
  DEFAULT_THEME,
  LAYOUT_TYPES,
  READING_STATUSES,
  SOURCE_TYPES,
  TEMPLATE_SORT_RULES,
} from './types.js';

export const readingStatusSchema = z.enum(READING_STATUSES);
export const layoutTypeSchema = z.enum(LAYOUT_TYPES);
export const sourceTypeSchema = z.enum(SOURCE_TYPES);
export const accessLevelSchema = z.enum(CONTENT_ACCESS_LEVELS);
export const templateSortRuleSchema = z.enum(TEMPLATE_SORT_RULES);

/** 只接受 http/https，拒绝带凭据的 URL（凭据会被写进日志或数据库） */
export const httpUrlSchema = z
  .string()
  .trim()
  .min(1, 'URL 不能为空')
  .max(2048, 'URL 过长')
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch {
      return false;
    }
  }, '只接受 http/https 且不含账号密码的链接');

export const themeSchema = z.object({
  paper: z.string(),
  paperTexture: z.enum(['plain', 'grain']),
  ink: z.string(),
  inkMuted: z.string(),
  rule: z.string(),
  accent: z.string(),
  bodyFontSize: z.number().min(12).max(24),
  bodyLineHeight: z.number().min(1.2).max(2.4),
  contentWidth: z.number().min(720).max(1600),
});

export const readingStatePatchSchema = z
  .object({
    status: readingStatusSchema.optional(),
    note: z.string().max(4000).nullable().optional(),
    progress: z.number().min(0).max(1).nullable().optional(),
  })
  .refine(
    (value) => value.status !== undefined || value.note !== undefined || value.progress !== undefined,
    '至少需要提供一个字段',
  );

export const articleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: readingStatusSchema.optional(),
  sourceId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const sourceCreateSchema = z.object({
  url: httpUrlSchema,
  name: z.string().trim().min(1, '名称不能为空').max(80).optional(),
  pollIntervalMinutes: z.coerce.number().int().min(5).max(10080).optional(),
  enabled: z.boolean().optional(),
  /** 默认关闭：只有用户明确开启的来源，采集后才尝试读取公开正文 */
  extractContent: z.boolean().optional(),
});

export const sourcePatchSchema = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(80).optional(),
    enabled: z.boolean().optional(),
    pollIntervalMinutes: z.coerce.number().int().min(5).max(10080).optional(),
    extractContent: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.enabled !== undefined ||
      value.pollIntervalMinutes !== undefined ||
      value.extractContent !== undefined,
    '至少需要修改一个字段',
  );

export const manualLinkSchema = z.object({
  url: httpUrlSchema,
  title: z.string().trim().min(1, '标题不能为空').max(300),
  summary: z.string().trim().max(1200).optional(),
  sourceId: z.coerce.number().int().positive().optional(),
});

/** 用户自己粘贴的正文：只存纯文本，标记为 user_provided，提取不会覆盖它 */
export const manualContentSchema = z.object({
  articleId: z.coerce.number().int().positive(),
  content: z.string().trim().min(20, '正文至少需要 20 个字符').max(200_000, '正文超过 20 万字符上限'),
});

const positiveIdArraySchema = z.array(z.coerce.number().int().positive()).max(50);

export const templateSectionFilterSchema = z.object({
  sourceIds: positiveIdArraySchema.optional(),
  maxAgeDays: z.coerce.number().int().min(1).max(365).optional(),
  pinnedArticleIds: positiveIdArraySchema.optional(),
});

export const templateSectionInputSchema = z.object({
  name: z.string().trim().min(1, '栏目名不能为空').max(20, '栏目名最长 20 字'),
  layoutType: layoutTypeSchema,
  maxArticles: z.coerce.number().int().min(1).max(30),
  filter: templateSectionFilterSchema.default({}),
  sortRule: templateSortRuleSchema.default('published_desc'),
});

export const templateSectionsSchema = z
  .array(templateSectionInputSchema)
  .min(1, '至少需要一个栏目')
  .max(12, '栏目最多 12 个')
  .superRefine((sections, ctx) => {
    const seen = new Set<string>();
    sections.forEach((section, index) => {
      if (seen.has(section.name)) {
        ctx.addIssue({ code: 'custom', message: '栏目名称不能重复', path: [index, 'name'] });
      }
      seen.add(section.name);
    });
  });

const templateFields = {
  name: z.string().trim().min(1, '模板名不能为空').max(60),
  mastheadTitle: z.string().trim().min(1, '刊名不能为空').max(40),
  subtitle: z.string().trim().max(160).default(''),
  dateFormat: z.string().trim().min(1).max(60).default('YYYY年M月D日 dddd'),
  theme: themeSchema.default(DEFAULT_THEME),
  maxTotalArticles: z.coerce.number().int().min(1).max(50).default(15),
  sections: templateSectionsSchema,
};

export const templateCreateSchema = z.object(templateFields);

export const templatePatchSchema = z
  .object({
    name: templateFields.name.optional(),
    mastheadTitle: templateFields.mastheadTitle.optional(),
    subtitle: z.string().trim().max(160).optional(),
    dateFormat: z.string().trim().min(1).max(60).optional(),
    theme: themeSchema.optional(),
    maxTotalArticles: z.coerce.number().int().min(1).max(50).optional(),
    sections: templateSectionsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, '至少需要修改一个字段');

export const issueDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    if (!year || !month || !day) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    );
  }, '这个日期不存在');

export const issuePreviewSchema = z.object({
  templateId: z.coerce.number().int().positive().optional(),
  date: issueDateSchema.optional(),
});

export const issueGenerateSchema = z.object({
  templateId: z.coerce.number().int().positive().optional(),
  date: issueDateSchema.optional(),
  /** 今天已有预览稿时，明确覆盖 */
  replaceDraft: z.boolean().optional(),
  /** true 直接出版；默认先存预览稿 */
  publish: z.boolean().optional(),
});

export const clockSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM（24 小时制）');

export const timeZoneSchema = z
  .string()
  .trim()
  .min(1, '时区不能为空')
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '不认识的时区名，请填 IANA 名称，例如 Asia/Shanghai');

const schedulePatchFields = {
  enabled: z.boolean().optional(),
  collectTime: clockSchema.optional(),
  timeZone: timeZoneSchema.optional(),
  autoGenerate: z.boolean().optional(),
  publish: z.boolean().optional(),
};

export const scheduleSettingsPatchSchema = z
  .object(schedulePatchFields)
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    '至少需要修改一个字段',
  );

export const settingsUpdateSchema = z.object({
  schedule: scheduleSettingsPatchSchema,
});

export const jobRunInputSchema = z.object({
  /** 补哪一天；缺省为设置时区的今天 */
  date: issueDateSchema.optional(),
  /** 跑完采集后是否编排；缺省跟随设置里的自动生成开关 */
  generate: z.boolean().optional(),
  /** 编排成功后是否直接出版；缺省跟随设置 */
  publish: z.boolean().optional(),
  /** 目标日期已有预览稿时是否覆盖；默认不覆盖 */
  replaceDraft: z.boolean().optional(),
});
