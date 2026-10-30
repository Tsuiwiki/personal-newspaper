/**
 * 时区与本地日期换算。
 *
 * 期刊日期、定时任务的“今天”和“几点”都以配置的 IANA 时区为准，
 * 存储层仍然是 UTC ISO 字符串。
 */

export const DAY_MS = 86_400_000;

export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return asUtc - date.getTime();
}

export function todayInTimeZone(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 本地日期 + 当天第几分钟；定时任务用它判断是否到点 */
export function localClock(timeZone: string, now = new Date()): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

/** 把本地日期零点换算成 UTC 时刻；两次迭代覆盖夏令时切换 */
export function zonedMidnightUtc(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const naive = Date.UTC(year!, month! - 1, day!);
  let utc = naive;
  for (let i = 0; i < 2; i += 1) {
    utc = naive - timeZoneOffsetMs(new Date(utc), timeZone);
  }
  return utc;
}

/**
 * 本地日期 + HH:MM 换算成 UTC 时刻。
 * 夏令时跳过的钟点（例如春季 02:30）会顺延到当天第一个存在的时刻。
 */
export function zonedTimeUtc(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const naive = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let utc = naive - timeZoneOffsetMs(new Date(naive), timeZone);
  for (let i = 0; i < 2; i += 1) {
    utc = naive - timeZoneOffsetMs(new Date(utc), timeZone);
  }
  return utc;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function parseClock(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

export function formatClock(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  return `${String(hour).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
