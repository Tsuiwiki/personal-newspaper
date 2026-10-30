import type { JobRunSummary, ScheduleSettings } from '@paper/shared';
import { addDays, localClock, parseClock, zonedTimeUtc } from '../time.js';

/** 定时任务失败后不要每个 tick 都重撞，等这么久再试 */
export const RETRY_COOLDOWN_MS = 10 * 60_000;

export interface SchedulePlan {
  due: boolean;
  nextRunAt: string | null;
  reason: 'disabled' | 'waiting' | 'due' | 'done' | 'retry_wait' | 'running';
}

/**
 * 只根据“今天是否已有定时运行记录”和当前本地时刻判断。
 * 当天成功/失败记录都在库中，所以进程重启不会重复生成同一天。
 */
export function planNextRun(
  settings: ScheduleSettings,
  lastScheduledToday: JobRunSummary | null,
  now: Date,
): SchedulePlan {
  if (!settings.enabled) return { due: false, nextRunAt: null, reason: 'disabled' };

  const clock = localClock(settings.timeZone, now);
  const targetMinutes = parseClock(settings.collectTime);
  const tomorrowAt = zonedTimeUtc(addDays(clock.date, 1), settings.collectTime, settings.timeZone);

  if (lastScheduledToday) {
    if (lastScheduledToday.status === 'running') {
      return { due: false, nextRunAt: null, reason: 'running' };
    }
    if (lastScheduledToday.status === 'failed') {
      const finishedAt = lastScheduledToday.finishedAt
        ? new Date(lastScheduledToday.finishedAt).getTime()
        : now.getTime();
      const retryAt = finishedAt + RETRY_COOLDOWN_MS;
      if (now.getTime() >= retryAt) return { due: true, nextRunAt: now.toISOString(), reason: 'due' };
      return { due: false, nextRunAt: new Date(retryAt).toISOString(), reason: 'retry_wait' };
    }
    return { due: false, nextRunAt: new Date(tomorrowAt).toISOString(), reason: 'done' };
  }

  if (clock.minutes >= targetMinutes) return { due: true, nextRunAt: now.toISOString(), reason: 'due' };
  return {
    due: false,
    nextRunAt: new Date(zonedTimeUtc(clock.date, settings.collectTime, settings.timeZone)).toISOString(),
    reason: 'waiting',
  };
}
