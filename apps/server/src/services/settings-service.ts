import { DEFAULT_SCHEDULE, type ScheduleSettings } from '@paper/shared';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { isValidTimeZone } from '../time.js';

const SCHEDULE_KEY = 'schedule';
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function defaultSchedule(): ScheduleSettings {
  return { ...DEFAULT_SCHEDULE, timeZone: config.timezone };
}

/** 单条设置损坏时逐字段回退，不让坏数据把定时任务整个带崩 */
function sanitize(raw: unknown): ScheduleSettings {
  const fallback = defaultSchedule();
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Record<string, unknown>;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    collectTime:
      typeof value.collectTime === 'string' && CLOCK_PATTERN.test(value.collectTime)
        ? value.collectTime
        : fallback.collectTime,
    timeZone:
      typeof value.timeZone === 'string' && isValidTimeZone(value.timeZone)
        ? value.timeZone
        : fallback.timeZone,
    autoGenerate: typeof value.autoGenerate === 'boolean' ? value.autoGenerate : fallback.autoGenerate,
    publish: typeof value.publish === 'boolean' ? value.publish : fallback.publish,
  };
}

export function getSchedule(db: Db): ScheduleSettings {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(SCHEDULE_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return defaultSchedule();
  try {
    return sanitize(JSON.parse(row.value_json));
  } catch {
    return defaultSchedule();
  }
}

export function updateSchedule(db: Db, patch: Partial<ScheduleSettings>): ScheduleSettings {
  const next: ScheduleSettings = { ...getSchedule(db), ...patch };
  db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES (@key, @value, @updatedAt)
     ON CONFLICT (key) DO UPDATE SET value_json = @value, updated_at = @updatedAt`,
  ).run({
    key: SCHEDULE_KEY,
    value: JSON.stringify(next),
    updatedAt: new Date().toISOString(),
  });
  return next;
}
