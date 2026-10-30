import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_THEME, type TemplateSectionInput } from '@paper/shared';
import { applyMigrations } from '../src/db/migrator.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { buildApp } from '../src/app.js';
import { createTemplate } from '../src/services/template-service.js';
import { getSchedule, updateSchedule } from '../src/services/settings-service.js';
import {
  getJobStatus,
  listRuns,
  recoverInterruptedRuns,
  runDailyJob,
} from '../src/services/job-service.js';
import { planNextRun } from '../src/services/schedule-plan.js';
import { createBackup, listBackups } from '../src/services/backup-service.js';
import { Scheduler } from '../src/scheduler.js';
import { localClock, todayInTimeZone, zonedTimeUtc } from '../src/time.js';
import type { CollectorOptions } from '../src/ingestion/fetch-source.js';
import type { SafeFetchResult } from '../src/security/url-guard.js';
import type { ScheduleSettings } from '@paper/shared';

const ORIGIN = 'http://localhost:5173';
const DATE = '2026-10-28';
const MORNING = new Date('2026-10-28T00:00:00.000Z'); // 上海时间 08:00

function memoryDb(): Db {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}

function section(name: string, layoutType: TemplateSectionInput['layoutType'], maxArticles: number): TemplateSectionInput {
  return { name, layoutType, maxArticles, filter: {}, sortRule: 'published_desc' };
}

function makeTemplate(db: Db): void {
  createTemplate(db, {
    name: '定时测试模板',
    mastheadTitle: '纸间',
    subtitle: '',
    dateFormat: 'YYYY年M月D日 dddd',
    theme: DEFAULT_THEME,
    maxTotalArticles: 10,
    sections: [section('头版', 'headline', 3), section('列表', 'list', 5)],
  });
}

let feedSeq = 0;

function rss(body: { title: string; link: string; guid: string }[], pubDate = 'Wed, 28 Oct 2026 01:00:00 GMT'): string {
  feedSeq += 1;
  const items = body
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link><guid>${item.guid}</guid>` +
        `<pubDate>${pubDate}</pubDate><description>${item.title} 的摘要</description></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>测试 Feed ${feedSeq}</title>` +
    `<link>https://example.test/</link>${items}</channel></rss>`;
}

function addSource(db: Db, name: string, url: string): number {
  const info = db
    .prepare('INSERT INTO sources (name, type, url) VALUES (?, ?, ?)')
    .run(name, 'rss', url);
  return Number(info.lastInsertRowid);
}

interface FakeCollector {
  collector: CollectorOptions;
  calls: Map<string, number>;
}

function fakeCollector(handler: (url: string, call: number) => string | Error): FakeCollector {
  const calls = new Map<string, number>();
  return {
    calls,
    collector: {
      fetchImpl: async (url): Promise<SafeFetchResult> => {
        const call = (calls.get(url) ?? 0) + 1;
        calls.set(url, call);
        const result = handler(url, call);
        if (result instanceof Error) throw result;
        return { status: 200, headers: {}, body: result, finalUrl: url, redirects: 0 };
      },
    },
  };
}

function write(app: FastifyInstance, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'POST',
    url,
    headers: { origin: ORIGIN },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

test('本地日期、时刻与夏令时换算', () => {
  assert.equal(todayInTimeZone('Asia/Shanghai', new Date('2026-10-27T16:30:00.000Z')), '2026-10-28');
  assert.deepEqual(localClock('Asia/Shanghai', new Date('2026-10-27T16:30:00.000Z')), {
    date: '2026-10-28',
    minutes: 30,
  });
  assert.deepEqual(localClock('America/New_York', new Date('2026-10-28T12:00:00.000Z')), {
    date: '2026-10-28',
    minutes: 8 * 60,
  });

  // 夏令时开始（2026-03-08 02:00 → 03:00）：07:30 是 EDT，UTC-4
  assert.equal(
    zonedTimeUtc('2026-03-08', '07:30', 'America/New_York'),
    Date.parse('2026-03-08T11:30:00.000Z'),
  );
  // 夏令时结束（2026-11-01）：07:30 是 EST，UTC-5
  assert.equal(
    zonedTimeUtc('2026-11-01', '07:30', 'America/New_York'),
    Date.parse('2026-11-01T12:30:00.000Z'),
  );
  // 上海没有夏令时
  assert.equal(
    zonedTimeUtc('2026-07-01', '07:30', 'Asia/Shanghai'),
    Date.parse('2026-06-30T23:30:00.000Z'),
  );
});

test('定时计划：未到点、到点、已完成与失败冷却', () => {
  const base: ScheduleSettings = {
    enabled: true,
    collectTime: '07:00',
    timeZone: 'Asia/Shanghai',
    autoGenerate: true,
    publish: false,
  };
  const before = new Date('2026-10-27T22:30:00.000Z'); // 上海 06:30
  const waiting = planNextRun(base, null, before);
  assert.equal(waiting.due, false);
  assert.equal(waiting.reason, 'waiting');
  assert.equal(new Date(waiting.nextRunAt!).toISOString(), '2026-10-27T23:00:00.000Z');

  const due = planNextRun(base, null, MORNING);
  assert.equal(due.due, true);
  assert.equal(due.reason, 'due');

  const done = planNextRun(
    base,
    {
      id: 1,
      trigger: 'schedule',
      runDate: DATE,
      status: 'ok',
      startedAt: MORNING.toISOString(),
      finishedAt: MORNING.toISOString(),
      detail: { sources: null, issue: null, note: null },
    },
    new Date('2026-10-28T02:00:00.000Z'),
  );
  assert.equal(done.due, false);
  assert.equal(done.reason, 'done');
  assert.equal(new Date(done.nextRunAt!).toISOString(), '2026-10-28T23:00:00.000Z');

  const failed = planNextRun(
    base,
    {
      id: 2,
      trigger: 'schedule',
      runDate: DATE,
      status: 'failed',
      startedAt: MORNING.toISOString(),
      finishedAt: MORNING.toISOString(),
      detail: { sources: null, issue: null, note: 'boom' },
    },
    new Date('2026-10-28T00:05:00.000Z'),
  );
  assert.equal(failed.due, false);
  assert.equal(failed.reason, 'retry_wait');
  assert.equal(new Date(failed.nextRunAt!).toISOString(), '2026-10-28T00:10:00.000Z');

  const disabled = planNextRun({ ...base, enabled: false }, null, MORNING);
  assert.equal(disabled.due, false);
  assert.equal(disabled.nextRunAt, null);
});

test('设置接口：默认值、持久化与非法时区/时刻', async () => {
  const db = memoryDb();
  const app = buildApp(db);

  const initial = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(initial.statusCode, 200);
  const initialBody = initial.json() as { schedule: ScheduleSettings; serverTimeZone: string };
  assert.equal(initialBody.schedule.collectTime, '07:00');
  assert.equal(initialBody.schedule.enabled, true);
  assert.equal(initialBody.schedule.timeZone, initialBody.serverTimeZone);

  const updated = await write(app, 'PATCH', '/api/settings', {
    schedule: { collectTime: '06:30', publish: true, enabled: false },
  });
  assert.equal(updated.statusCode, 200);
  const updatedBody = updated.json() as { schedule: ScheduleSettings };
  assert.equal(updatedBody.schedule.collectTime, '06:30');
  assert.equal(updatedBody.schedule.publish, true);
  assert.equal(updatedBody.schedule.enabled, false);
  assert.deepEqual(getSchedule(db), updatedBody.schedule);

  for (const bad of [
    { schedule: { collectTime: '25:00' } },
    { schedule: { timeZone: 'Mars/Olympus' } },
    { schedule: {} },
  ]) {
    const rejected = await write(app, 'PATCH', '/api/settings', bad);
    assert.equal(rejected.statusCode, 400);
    assert.equal((rejected.json() as { error: { code: string } }).error.code, 'E_VALIDATION');
  }

  await app.close();
  db.close();
});

test('设置里的时区决定手动预览默认的“今天”', async () => {
  const db = memoryDb();
  makeTemplate(db);
  updateSchedule(db, { timeZone: 'Pacific/Kiritimati' }); // UTC+14
  const app = buildApp(db);

  const before = todayInTimeZone('Pacific/Kiritimati');
  const response = await write(app, 'POST', '/api/issues/preview', {});
  const after = todayInTimeZone('Pacific/Kiritimati');
  assert.equal(response.statusCode, 200);
  const body = response.json() as { issueDate: string };
  assert.ok([before, after].includes(body.issueDate), `issueDate ${body.issueDate} 不是设置时区的今天`);

  await app.close();
  db.close();
});

test('每日任务：采集、自动生成预览稿，同一天不重复跑同一期', async () => {
  const db = memoryDb();
  makeTemplate(db);
  const url = 'https://example.test/daily/feed.xml';
  addSource(db, '每日来源', url);
  const fake = fakeCollector(() =>
    rss([
      { title: '定时文章一', link: 'https://example.test/posts/1', guid: 'daily-1' },
      { title: '定时文章二', link: 'https://example.test/posts/2', guid: 'daily-2' },
    ]),
  );

  const first = await runDailyJob(db, {
    trigger: 'schedule',
    runDate: DATE,
    now: MORNING,
    collector: fake.collector,
    retryDelayMs: 0,
  });
  assert.equal(first.skipped, null);
  const run = first.run!;
  assert.equal(run.status, 'ok');
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.runDate, DATE);
  assert.equal(run.detail.sources?.inserted, 2);
  assert.equal(run.detail.issue?.generated, true);
  assert.equal(run.detail.issue?.issueStatus, 'draft');
  assert.equal(run.detail.issue?.total, 2);

  const again = await runDailyJob(db, {
    trigger: 'schedule',
    runDate: DATE,
    now: new Date('2026-10-28T02:00:00.000Z'),
    collector: fake.collector,
    retryDelayMs: 0,
  });
  assert.equal(again.skipped, 'already_ran');
  assert.equal(fake.calls.get(url), 1, '重复的定时运行不应再次请求来源');
  assert.equal(listRuns(db).length, 1);

  const manual = await runDailyJob(db, {
    trigger: 'manual',
    runDate: DATE,
    now: MORNING,
    generate: true,
    collector: fake.collector,
    retryDelayMs: 0,
  });
  assert.equal(manual.run!.status, 'partial');
  assert.equal(manual.run!.detail.issue?.reason, 'draft_exists');
  assert.equal(manual.run!.detail.issue?.issueId, run.detail.issue?.issueId);

  const replaced = await runDailyJob(db, {
    trigger: 'manual',
    runDate: DATE,
    now: MORNING,
    generate: true,
    replaceDraft: true,
    publish: true,
    collector: fake.collector,
    retryDelayMs: 0,
  });
  assert.equal(replaced.run!.detail.issue?.generated, true);
  assert.equal(replaced.run!.detail.issue?.issueStatus, 'published');
  assert.equal(replaced.run!.detail.issue?.issueId, run.detail.issue?.issueId);

  const locked = await runDailyJob(db, {
    trigger: 'manual',
    runDate: DATE,
    now: MORNING,
    generate: true,
    publish: true,
    replaceDraft: true,
    collector: fake.collector,
    retryDelayMs: 0,
  });
  assert.equal(locked.run!.status, 'partial');
  assert.equal(locked.run!.detail.issue?.reason, 'issue_exists');

  assert.equal(listRuns(db).length, 4);
  db.close();
});

test('来源失败不拖垮整体：失败重试一次并记录，成功来源照常入库', async () => {
  const db = memoryDb();
  makeTemplate(db);
  const goodUrl = 'https://example.test/good/feed.xml';
  const badUrl = 'https://example.test/bad/feed.xml';
  addSource(db, '好来源', goodUrl);
  addSource(db, '坏来源', badUrl);
  const fake = fakeCollector((url) =>
    url === goodUrl
      ? rss([{ title: '好消息', link: 'https://example.test/good/1', guid: 'good-1' }])
      : new Error('连接被拒绝'),
  );

  const result = await runDailyJob(db, {
    trigger: 'schedule',
    runDate: DATE,
    now: MORNING,
    collector: fake.collector,
    retryDelayMs: 0,
  });
  const run = result.run!;
  assert.equal(run.status, 'partial');
  assert.equal(run.detail.sources?.total, 2);
  assert.equal(run.detail.sources?.ok, 1);
  assert.equal(run.detail.sources?.failed, 1);
  assert.equal(run.detail.issue?.generated, true);
  const bad = run.detail.sources?.results.find((item) => item.name === '坏来源');
  assert.equal(bad?.ok, false);
  assert.equal(bad?.attempts, 2);
  assert.match(bad?.error ?? '', /连接被拒绝/);
  assert.equal(fake.calls.get(badUrl), 2);
  assert.equal(fake.calls.get(goodUrl), 1);
  db.close();
});

test('调度器：到点只跑一次，下一期排到明天；停用后不再排程', async () => {
  const db = memoryDb();
  makeTemplate(db);
  addSource(db, '调度来源', 'https://example.test/scheduler/feed.xml');
  const fake = fakeCollector(() =>
    rss([{ title: '调度文章', link: 'https://example.test/scheduler/1', guid: 'scheduler-1' }]),
  );
  const scheduler = new Scheduler({
    db,
    collector: fake.collector,
    retryDelayMs: 0,
    tickMs: 60_000,
    now: () => MORNING,
  });

  await scheduler.tickNow(MORNING);
  assert.equal(listRuns(db).length, 1);
  assert.equal(new Date(scheduler.nextRunAt()!).toISOString(), '2026-10-28T23:00:00.000Z');

  await scheduler.tickNow(new Date('2026-10-28T02:00:00.000Z'));
  assert.equal(listRuns(db).length, 1, '同一天第二次 tick 不重复执行');

  updateSchedule(db, { enabled: false });
  await scheduler.tickNow(new Date('2026-10-29T00:00:00.000Z'));
  assert.equal(scheduler.nextRunAt(), null);

  await scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
  db.close();
});

test('调度器启动：停用时不触发，并标记上次进程遗留的 running 记录', async () => {
  const db = memoryDb();
  updateSchedule(db, { enabled: false });
  db.prepare(
    `INSERT INTO job_runs (job, trigger, run_date, status, started_at, detail_json)
     VALUES ('daily', 'schedule', '2026-10-27', 'running', '2026-10-27T00:00:00.000Z', '{}')`,
  ).run();
  assert.equal(recoverInterruptedRuns(db), 1);
  const row = db.prepare("SELECT status, detail_json FROM job_runs WHERE run_date = '2026-10-27'").get() as {
    status: string;
    detail_json: string;
  };
  assert.equal(row.status, 'failed');
  assert.match(row.detail_json, /任务完成前退出/);

  const scheduler = new Scheduler({ db, tickMs: 60_000, now: () => MORNING });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(scheduler.isRunning(), true);
  assert.equal(scheduler.nextRunAt(), null);
  assert.equal(listRuns(db).length, 1, '停用时启动不应执行任务');
  await scheduler.stop();
  db.close();
});

test('任务接口：状态、手动运行与并发保护', async () => {
  const db = memoryDb();
  makeTemplate(db);
  const url = 'https://example.test/api/feed.xml';
  addSource(db, '接口来源', url);

  let release: ((value: SafeFetchResult) => void) | null = null;
  const gate = new Promise<SafeFetchResult>((resolve) => {
    release = resolve;
  });
  const collector: CollectorOptions = { fetchImpl: () => gate };
  const app = buildApp(db, {
    collector,
    scheduler: { isRunning: () => true, nextRunAt: () => '2026-10-28T23:00:00.000Z' },
  });

  const status = await app.inject({ method: 'GET', url: '/api/jobs/status' });
  assert.equal(status.statusCode, 200);
  const statusBody = status.json() as {
    schedule: ScheduleSettings;
    status: { running: boolean; nextRunAt: string | null; localDate: string; recentRuns: unknown[] };
  };
  assert.equal(statusBody.status.running, true);
  assert.equal(statusBody.status.nextRunAt, '2026-10-28T23:00:00.000Z');
  assert.match(statusBody.status.localDate, /^\d{4}-\d{2}-\d{2}$/);

  const running = runDailyJob(db, {
    trigger: 'manual',
    runDate: DATE,
    now: MORNING,
    generate: false,
    collector,
    retryDelayMs: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const busy = await write(app, 'POST', '/api/jobs/run', { generate: false });
  assert.equal(busy.statusCode, 409);
  assert.equal((busy.json() as { error: { code: string } }).error.code, 'E_JOB_RUNNING');

  release!({
    status: 200,
    headers: {},
    body: rss([{ title: '接口文章', link: 'https://example.test/api/1', guid: 'api-1' }]),
    finalUrl: url,
    redirects: 0,
  });
  const finished = await running;
  assert.equal(finished.run!.status, 'ok');
  assert.equal(finished.run!.detail.issue, null);

  const runs = await app.inject({ method: 'GET', url: '/api/jobs/runs?limit=5' });
  assert.equal(runs.statusCode, 200);
  assert.equal((runs.json() as { items: unknown[] }).items.length, 1);

  const badDate = await write(app, 'POST', '/api/jobs/run', { date: '2026-02-31' });
  assert.equal(badDate.statusCode, 400);

  await app.close();
  db.close();
});

test('备份：生成可恢复的副本，设置与数据在重启后仍在', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-phase4-'));
  const backupDir = path.join(tmp, 'backups');
  const db = memoryDb();
  makeTemplate(db);
  updateSchedule(db, { collectTime: '08:15', timeZone: 'Europe/Berlin' });
  const backup = await createBackup(db, backupDir);
  assert.equal(backup.kind, 'manual');
  assert.ok(fs.existsSync(path.join(backupDir, backup.file)));
  assert.equal(listBackups(backupDir).length, 1);

  const copyPath = path.join(tmp, 'restored.db');
  fs.copyFileSync(path.join(backupDir, backup.file), copyPath);
  const restored = await openDatabase({
    databasePath: copyPath,
    backupDir,
    runMigrations: false,
  });
  const integrity = restored.pragma('integrity_check', { simple: true });
  assert.equal(integrity, 'ok');
  assert.equal(
    (restored.prepare('SELECT COUNT(*) AS n FROM templates').get() as { n: number }).n,
    1,
  );
  assert.equal(getSchedule(restored).collectTime, '08:15');
  assert.equal(getSchedule(restored).timeZone, 'Europe/Berlin');
  restored.close();
  db.close();

  const reopened = await openDatabase({
    databasePath: copyPath,
    backupDir,
    runMigrations: false,
  });
  assert.equal(getSchedule(reopened).collectTime, '08:15');
  reopened.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('任务状态汇总包含今天的记录与最近运行', () => {
  const db = memoryDb();
  const empty = getJobStatus(db, { now: MORNING });
  assert.equal(empty.status.todayRun, null);
  assert.equal(empty.status.lastRun, null);
  assert.equal(empty.schedule.collectTime, '07:00');

  db.prepare(
    `INSERT INTO job_runs (job, trigger, run_date, status, started_at, finished_at, detail_json)
     VALUES ('daily', 'manual', @date, 'ok', '2026-10-28T01:00:00.000Z', '2026-10-28T01:01:00.000Z',
             '{"sources":null,"issue":null,"note":"手动跑了一次"}')`,
  ).run({ date: DATE });

  const filled = getJobStatus(db, { now: MORNING });
  assert.equal(filled.status.todayRun?.id, 1);
  assert.equal(filled.status.lastRun?.detail.note, '手动跑了一次');
  assert.equal(filled.status.recentRuns.length, 1);
  db.close();
});
