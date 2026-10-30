import type { CollectorOptions } from './ingestion/fetch-source.js';
import type { Db } from './db/index.js';
import { logger } from './logger.js';
import { localClock } from './time.js';
import {
  getScheduledRun,
  recoverInterruptedRuns,
  runDailyJob,
  type SchedulerLike,
} from './services/job-service.js';
import { planNextRun, type SchedulePlan } from './services/schedule-plan.js';
import { getSchedule } from './services/settings-service.js';

const log = logger.child('scheduler');

export interface SchedulerOptions {
  db: Db;
  collector?: CollectorOptions;
  /** 检查是否到点的间隔；默认 30 秒 */
  tickMs?: number;
  now?: () => Date;
  retryDelayMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * 应用内调度器：只保留一个定时器，每次 tick 重新读设置和当天的运行记录，
 * 因此改设置、重启进程都不需要迁移内存状态。
 */
export class Scheduler implements SchedulerLike {
  private readonly db: Db;
  private readonly collector?: CollectorOptions;
  private readonly tickMs: number;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly onError?: (error: unknown) => void;

  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private next: string | null = null;

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.collector = options.collector;
    this.tickMs = Math.max(options.tickMs ?? 30_000, 1_000);
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 1500;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer) return;
    const recovered = recoverInterruptedRuns(this.db);
    if (recovered > 0) log.warn('标记了上次进程遗留的运行记录', { recovered });

    this.refresh();
    this.timer = setInterval(() => {
      void this.tickNow().catch((error) => this.report(error));
    }, this.tickMs);
    this.timer.unref?.();
    void this.tickNow().catch((error) => this.report(error));
    log.info('定时任务已启动', { nextRunAt: this.next, tickMs: this.tickMs });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.next = null;
    const current = this.current;
    if (current) await current.catch(() => undefined);
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  nextRunAt(): string | null {
    return this.next;
  }

  /** 设置变更后立即重算，不必等下一次 tick */
  syncPlan(): void {
    this.refresh();
  }

  /** 手动推进一次检查；测试和“立即运行”都走这里 */
  tickNow(now = this.now()): Promise<void> {
    if (this.current) return this.current;
    const task = this.execute(now).finally(() => {
      this.current = null;
    });
    this.current = task;
    return task;
  }

  private refresh(now = this.now()): SchedulePlan {
    const settings = getSchedule(this.db);
    const clock = localClock(settings.timeZone, now);
    const plan = planNextRun(settings, getScheduledRun(this.db, clock.date), now);
    this.next = plan.nextRunAt;
    return plan;
  }

  private async execute(now: Date): Promise<void> {
    try {
      const plan = this.refresh(now);
      if (!plan.due) return;

      const settings = getSchedule(this.db);
      const { date } = localClock(settings.timeZone, now);
      const outcome = await runDailyJob(this.db, {
        trigger: 'schedule',
        runDate: date,
        generate: settings.autoGenerate,
        publish: settings.publish,
        collector: this.collector,
        now,
        retryDelayMs: this.retryDelayMs,
      });
      if (outcome.skipped) {
        log.info('本轮定时任务跳过', { reason: outcome.skipped, runDate: date });
      } else {
        log.info('定时任务完成', {
          runDate: date,
          status: outcome.run.status,
          note: outcome.run.detail.note,
        });
      }
    } catch (error) {
      this.report(error);
    } finally {
      this.refresh(this.now());
    }
  }

  private report(error: unknown): void {
    log.error('定时任务出错', { error });
    this.onError?.(error);
  }
}
