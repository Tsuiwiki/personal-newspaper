import type {
  ArticleDetail,
  ArticleListPage,
  BackupFile,
  ExtractionResult,
  FetchAllResult,
  IssueGenerateResult,
  IssuePreview,
  IssueSummary,
  IssueView,
  JobRunSummary,
  ReadingStatus,
  ScheduleSettings,
  SchedulerStatus,
  SettingsView,
  SourceCreateResult,
  SourceFetchResult,
  SourceSummary,
  TemplateSectionInput,
  TemplateView,
  ThemeSettings,
} from '@paper/shared';

export interface TemplatePayload {
  name: string;
  mastheadTitle: string;
  subtitle: string;
  dateFormat: string;
  theme: ThemeSettings;
  maxTotalArticles: number;
  sections: TemplateSectionInput[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'E_NETWORK', '连不上本地服务，请确认后端已启动（默认 127.0.0.1:8787）');
  }

  if (!response.ok) {
    let code = `E_HTTP_${response.status}`;
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // 非 JSON 错误体，保留默认文案
    }
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

export const api = {
  latestIssue: () => request<IssueView | null>('/api/issues/latest'),
  issue: (id: number) => request<IssueView>(`/api/issues/${id}`),
  issues: () => request<{ items: IssueSummary[] }>('/api/issues'),
  previewIssue: (input: { date?: string; templateId?: number } = {}) =>
    request<IssuePreview>('/api/issues/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  generateIssue: (input: {
    date?: string;
    templateId?: number;
    replaceDraft?: boolean;
    publish?: boolean;
  } = {}) =>
    request<IssueGenerateResult>('/api/issues/generate', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  publishIssue: (id: number) => request<IssueView>(`/api/issues/${id}/publish`, { method: 'POST' }),
  templates: () => request<{ items: TemplateView[] }>('/api/templates'),
  createTemplate: (payload: TemplatePayload) =>
    request<TemplateView>('/api/templates', { method: 'POST', body: JSON.stringify(payload) }),
  updateTemplate: (id: number, payload: TemplatePayload) =>
    request<TemplateView>(`/api/templates/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  copyTemplate: (id: number) =>
    request<TemplateView>(`/api/templates/${id}/copy`, { method: 'POST' }),
  setDefaultTemplate: (id: number) =>
    request<TemplateView>(`/api/templates/${id}/default`, { method: 'POST' }),
  article: (id: number) => request<ArticleDetail>(`/api/articles/${id}`),
  articles: (
    params: {
      page?: number;
      pageSize?: number;
      status?: ReadingStatus;
      sourceId?: number;
      q?: string;
    } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.page) search.set('page', String(params.page));
    if (params.pageSize) search.set('pageSize', String(params.pageSize));
    if (params.status) search.set('status', params.status);
    if (params.sourceId) search.set('sourceId', String(params.sourceId));
    if (params.q) search.set('q', params.q);
    const query = search.toString();
    return request<ArticleListPage>(`/api/articles${query ? `?${query}` : ''}`);
  },
  sources: () => request<{ items: SourceSummary[] }>('/api/sources'),
  createSource: (input: { url: string; name?: string }) =>
    request<SourceCreateResult>('/api/sources', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateSource: (
    id: number,
    patch: { name?: string; enabled?: boolean; pollIntervalMinutes?: number; extractContent?: boolean },
  ) =>
    request<SourceSummary>(`/api/sources/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteSource: (id: number) =>
    request<{ deleted: true; keptArticles: number }>(`/api/sources/${id}`, { method: 'DELETE' }),
  validateSource: (id: number) =>
    request<{ ok: true; feedTitle: string | null; format: string; siteUrl: string | null; entryCount: number }>(
      `/api/sources/${id}/validate`,
      { method: 'POST' },
    ),
  fetchSource: (id: number) =>
    request<{ source: SourceSummary; fetch: SourceFetchResult }>(`/api/sources/${id}/fetch`, { method: 'POST' }),
  fetchAllSources: () => request<FetchAllResult>('/api/jobs/fetch-all', { method: 'POST' }),
  settings: () => request<SettingsView>('/api/settings'),
  updateSettings: (schedule: Partial<ScheduleSettings>) =>
    request<SettingsView>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ schedule }),
    }),
  jobStatus: () =>
    request<{ schedule: ScheduleSettings; status: SchedulerStatus }>('/api/jobs/status'),
  jobRuns: (limit = 20) =>
    request<{ items: JobRunSummary[] }>(`/api/jobs/runs?limit=${limit}`),
  runJob: (
    input: { date?: string; generate?: boolean; publish?: boolean; replaceDraft?: boolean } = {},
  ) =>
    request<JobRunSummary>('/api/jobs/run', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  backups: () => request<{ dir: string; items: BackupFile[] }>('/api/backups'),
  createBackup: () => request<BackupFile>('/api/backups', { method: 'POST' }),
  addManualLink: (input: { url: string; title: string; summary?: string }) =>
    request<ArticleDetail>('/api/articles/manual-link', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setReadingState: (id: number, patch: { status?: ReadingStatus; note?: string | null }) =>
    request<ArticleDetail>(`/api/articles/${id}/reading-state`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  extractArticle: (id: number) =>
    request<ExtractionResult>(`/api/articles/${id}/extract`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  saveManualContent: (id: number, content: string) =>
    request<ArticleDetail>('/api/articles/manual-content', {
      method: 'POST',
      body: JSON.stringify({ articleId: id, content }),
    }),
};
