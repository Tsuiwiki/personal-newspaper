const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 支持模板里的 YYYY、MM、DD、dddd 占位符 */
export function formatIssueDate(value: string, format = 'YYYY年M月D日 dddd'): string {
  const date = parseLocalDate(value);
  if (!date) return value;
  return format
    .replace(/YYYY/g, String(date.getFullYear()))
    .replace(/MM/g, String(date.getMonth() + 1).padStart(2, '0'))
    .replace(/DD/g, String(date.getDate()).padStart(2, '0'))
    .replace(/dddd/g, WEEKDAYS[date.getDay()] ?? '')
    .replace(/(?<!M)M(?!M)/g, String(date.getMonth() + 1))
    .replace(/(?<!D)D(?!D)/g, String(date.getDate()));
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const diffMinutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays} 天前`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function paragraphList(text: string | null): string[] {
  if (!text) return [];
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
