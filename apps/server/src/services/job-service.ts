import type {
  JobIssueResult,
  JobRunDetail,
  JobRunSummary,
  JobSourceResult,
  JobStatus,
  JobTrigger,
  ScheduleSettings,
  SchedulerStatus,
} from '@paper/shared';
import type { Db } from '../db/index.js';
import { ApiError } from '../errors.js';
import { fetchSource, type CollectorOptions } from '../ingestion/fetch-source.js';
import { mapLimit } from '../ingestion/limiter.js';
import { logger } from '../logger.js';
import { formatClock, localClock, todayInTimeZone } from '../time.js';
import { generateIssue } from './issue-builder.js';
import { planNextRun } from './schedule-plan.js';
import { getSchedule } from './settings-service.js';
import { listEnabledSourceRows } from './source-service.js';

const log = logger.child('jobs');

/** 同一进程内一次只允许一个采集/生成任务，避免手动触发和定时任务撞在一起 */
const activeDbs = new WeakSet<Db>();

export function isJobRunning(db: Db): boolean {
  return activeDbs.has(db);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CollectOutcome {
  results: JobSourceResult[];
  totals: { sources: number; ok: number; failed: number; inserted: number; duplicates: number };
}

export interface CollectOptions {
  /** 失败来源再试几次；定时任务默认 1，手动“采集全部”保持 0 */
  retries?: number;
  retryDelayMs?: number;
}

export async function collectEnabledSources(
  db: Db,
  collector: CollectorOptions = {},
  options: CollectOptions = {},
): Promise<CollectOutcome> {
  const rows = listEnabledSourceRows(db);
  const results = await mapLimit(rows, 3, async (row): Promise<JobSourceResult | null> => {
    const outcome = await fetchSource(db, row.id, collector);
    return outcome ? { ...outcome, attempts: 1 } : null;
  });
  const collected = results.filter((item): item is JobSourceResult => item !== null);

  const retries = Math.max(0, options.retries ?? 0);
  const retryDelayMs = options.retryDelayMs ?? 1500;
  for (const failed of collected.filter((item) => !item.ok)) {
    if (retries === 0) break;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      await delay(retryDelayMs);
      const retry = await fetchSource(db, failed.sourceId, collector);
      if (!retry) break;
      const index = collected.findIndex((item) => item.sourceId === failed.sourceId);
      const next = { ...retry, attempts: failed.attempts + attempt };
      if (index >= 0) collected[index] = next;
      if (retry.ok) break;
    }
  }

  return {
    results: collected,
    totals: {
      sources: collected.length,
      ok: collected.filter((item) => item.ok).length,
      failed: collected.filter((item) => !item.ok).length,
      inserted: collected.reduce((sum, item) => sum + item.inserted, 0),
      duplicates: collected.reduce((sum, item) => sum + item.duplicates, 0),
    },
  };
}

const EMPTY_DETAIL: JobRunDetail = { sources: null, issue: null, note: null };

interface JobRunRow {
  id: number;
  trigger: JobTrigger;
  run_date: string;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  detail_json: string;
}

function parseDetail(json: string): JobRunDetail {
  try {
    const parsed = JSON.parse(json) as Partial<JobRunDetail>;
    return {
      sources: parsed.sources ?? null,
      issue: parsed.issue ?? null,
      note: typeof parsed.note === 'string' ? parsed.note : null,
    };
  } catch {
    return { ...EMPTY_DETAIL };
  }
}

function toSummary(row: JobRunRow): JobRunSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    runDate: row.run_date,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    detail: parseDetail(row.detail_json),
  };
}

export function getRun(db: Db, id: number): JobRunSummary | null {
  const row = db.prepare('SELECT * FROM job_runs WHERE id = ?').get(id) as JobRunRow | undefined;
  return row ? toSummary(row) : null;
}

export function listRuns(db: Db, limit = 20): JobRunSummary[] {
  const rows = db
    .prepare('SELECT * FROM job_runs ORDER BY started_at DESC, id DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 100)) as JobRunRow[];
  return rows.map(toSummary);
}

export function getScheduledRun(db: Db, runDate: string): JobRunSummary | null {
  const row = db
    .prepare(
      `SELECT * FROM job_runs
       WHERE job = 'daily' AND trigger = 'schedule' AND run_date = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    )
    .get(runDate) as JobRunRow | undefined;
  return row ? toSummary(row) : null;
}

export function getTodayRun(db: Db, runDate: string): JobRunSummary | null {
  const row = db
    .prepare(
      `SELECT * FROM job_runs
       WHERE job = 'daily' AND run_date = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    )
    .get(runDate) as JobRunRow | undefined;
  return row ? toSummary(row) : null;
}

/**
 * 进程启动时，上次进程留下的 running 记录已经没有对应的执行者。
 * 标记为失败并保留原开始时间，让调度器可以按冷却规则重试。
 */
export function recoverInterruptedRuns(db: Db): number {
  const rows = db.prepare("SELECT id, started_at FROM job_runs WHERE status = 'running'").all() as Array<{
    id: number;
    started_at: string;
  }>;
  if (rows.length === 0) return 0;
  const detail = JSON.stringify({
    sources: null,
    issue: null,
    note: '服务在任务完成前退出，本次运行被标记为失败；到点后会自动重试。',
  });
  const update = db.prepare(
    `UPDATE job_runs
     SET status = 'failed', finished_at = started_at, detail_json = ?
     WHERE id = ?`,
  );
  const apply = db.transaction(() => {
    for (const row of rows) update.run(detail, row.id);
  });
  apply();
  return rows.length;
}

function findIssue(
  db: Db,
  date: string,
): { id: number; status: 'draft' | 'published' | 'failed' } | null {
  const row = db
    .prepare('SELECT id, status FROM issues WHERE issue_date = ? AND issue_number = 1')
    .get(date) as { id: number; status: 'draft' | 'published' | 'failed' } | undefined;
  return row ?? null;
}

function generateForDate(
  db: Db,
  date: string,
  timeZone: string,
  publish: boolean,
  replaceDraft: boolean,
): JobIssueResult {
  const existing = findIssue(db, date);
  if (existing) {
    if (existing.status === 'published') {
      return {
        generated: false,
        issueId: existing.id,
        issueStatus: existing.status,
        total: 0,
        reason: 'issue_exists',
        message: `${date} 已经出版，未重新生成`,
      };
    }
    if (!replaceDraft) {
      return {
        generated: false,
        issueId: existing.id,
        issueStatus: existing.status,
        total: 0,
        reason: 'draft_exists',
        message: `${date} 已有预览稿，定时任务不会覆盖；需要手动确认后替换`,
      };
    }
  }

  try {
    const result = generateIssue(db, { date, timeZone, publish, replaceDraft });
    if (!result.generated) {
      return {
        generated: false,
        issueId: existing?.id ?? null,
        issueStatus: existing?.status ?? null,
        total: 0,
        reason: result.reason,
        message: `${date} 没有可编的候选文章，未生成空刊`,
      };
    }
    return {
      generated: true,
      issueId: result.issue!.id,
      issueStatus: result.issue!.status,
      total: result.preview.total,
      reason: null,
      message: publish ? `已生成并出版 ${result.preview.total} 篇` : `已生成预览稿 ${result.preview.total} 篇`,
    };
  } catch (cause) {
    if (cause instanceof ApiError) {
      return {
        generated: false,
        issueId: existing?.id ?? null,
        issueStatus: existing?.status ?? null,
        total: 0,
        reason: cause.code === 'E_ISSUE_EXISTS' ? 'issue_exists' : 'error',
        message: cause.message,
      };
    }
    throw cause;
  }
}

function computeStatus(sources: CollectOutcome, issue: JobIssueResult | null): JobStatus {
  if (sources.totals.failed > 0) return 'partial';
  if (issue && !issue.generated && issue.reason !== 'no_recent' && issue.reason !== 'all_used' && issue.reason !== 'filters') {
    return 'partial';
  }
  return 'ok';
}

function describeRun(sources: CollectOutcome, issue: JobIssueResult | null): string {
  const parts: string[] = [];
  if (sources.totals.sources === 0) {
    parts.push('没有启用的来源');
  } else {
    parts.push(
      `来源 ${sources.totals.sources} 个：成功 ${sources.totals.ok}，失败 ${sources.totals.failed}，新增 ${sources.totals.inserted} 篇`,
    );
  }
  if (issue) parts.push(issue.message ?? (issue.generated ? '已生成一期' : '未生成期刊'));
  return parts.join('；');
}

function insertRun(db: Db, trigger: JobTrigger, runDate: string, startedAt: string): number {
  const info = db
    .prepare(
      `INSERT INTO job_runs (job, trigger, run_date, status, started_at, detail_json)
       VALUES ('daily', @trigger, @runDate, 'running', @startedAt, @detail)`,
    )
    .run({ trigger, runDate, startedAt, detail: JSON.stringify(EMPTY_DETAIL) });
  return Number(info.lastInsertRowid);
}

function finishRun(db: Db, id: number, status: JobStatus, detail: JobRunDetail, finishedAt: string): void {
  db.prepare(
    'UPDATE job_runs SET status = ?, finished_at = ?, detail_json = ? WHERE id = ?',
  ).run(status, finishedAt, JSON.stringify(detail), id);
}

export interface RunDailyOptions {
  trigger: JobTrigger;
  /** 任务归属的本地日期；缺省为设置时区的今天 */
  runDate?: string;
  generate?: boolean;
  publish?: boolean;
  replaceDraft?: boolean;
  collector?: CollectorOptions;
  now?: Date;
  retries?: number;
  retryDelayMs?: number;
}

export type RunDailyOutcome =
  | { skipped: 'busy' | 'already_ran'; run: null }
  | { skipped: null; run: JobRunSummary };

export async function runDailyJob(db: Db, options: RunDailyOptions): Promise<RunDailyOutcome> {
  if (activeDbs.has(db)) return { skipped: 'busy', run: null };

  const settings: ScheduleSettings = getSchedule(db);
  const now = options.now ?? new Date();
  const runDate = options.runDate ?? todayInTimeZone(settings.timeZone, now);
  const startedAt = now.toISOString();

  activeDbs.add(db);
  let runId: number;
  try {
    runId = insertRun(db, options.trigger, runDate, startedAt);
  } catch (cause) {
    activeDbs.delete(db);
    if (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)) {
      return { skipped: 'already_ran', run: null };
    }
    throw cause;
  }

  const generate = options.generate ?? settings.autoGenerate;
  const publish = options.publish ?? settings.publish;
  let status: JobStatus = 'ok';
  const detail: JobRunDetail = { ...EMPTY_DETAIL };

  try {
    const sources = await collectEnabledSources(db, options.collector, {
      retries: options.retries ?? 1,
      retryDelayMs: options.retryDelayMs ?? 1500,
    });
    detail.sources = {
      total: sources.totals.sources,
      ok: sources.totals.ok,
      failed: sources.totals.failed,
      inserted: sources.totals.inserted,
      duplicates: sources.totals.duplicates,
      results: sources.results,
    };
    detail.issue = generate
      ? generateForDate(db, runDate, settings.timeZone, publish, options.replaceDraft ?? false)
      : null;
    status = computeStatus(sources, detail.issue);
    detail.note = describeRun(sources, detail.issue);
  } catch (cause) {
    status = 'failed';
    detail.note = cause instanceof Error ? cause.message.slice(0, 300) : '任务失败，请查看日志';
    log.error('任务执行失败', { runId, trigger: options.trigger, error: cause });
  } finally {
    finishRun(db, runId, status, detail, new Date().toISOString());
    activeDbs.delete(db);
  }

  const run = getRun(db, runId);
  if (!run) throw new Error(`任务记录 ${runId} 写入后读不回来`);
  return { skipped: null, run };
}

export interface SchedulerLike {
  isRunning(): boolean;
  nextRunAt(): string | null;
  syncPlan?(): void;
}

export interface JobStatusView {
  schedule: ScheduleSettings;
  status: SchedulerStatus;
}

export function getJobStatus(
  db: Db,
  options: { scheduler?: SchedulerLike | null; now?: Date } = {},
): JobStatusView {
  const schedule = getSchedule(db);
  const now = options.now ?? new Date();
  const clock = localClock(schedule.timeZone, now);
  const scheduledToday = getScheduledRun(db, clock.date);
  const plan = planNextRun(schedule, scheduledToday, now);
  const lastRun = listRuns(db, 1)[0] ?? null;

  return {
    schedule,
    status: {
      running: options.scheduler?.isRunning() ?? false,
      nextRunAt: options.scheduler?.nextRunAt() ?? plan.nextRunAt,
      localDate: clock.date,
      localTime: formatClock(clock.minutes),
      todayRun: getTodayRun(db, clock.date),
      lastRun,
      recentRuns: listRuns(db, 10),
    },
  };
}
