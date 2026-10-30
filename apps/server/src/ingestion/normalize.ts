import { createHash } from 'node:crypto';

/** 常见的跟踪参数，规范化 URL 时丢弃；保留可能影响内容的参数 */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^yclid$/i,
  /^msclkid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^spm$/i,
  /^ref_src$/i,
  /^__twitter_impression$/i,
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  laquo: '«',
  raquo: '»',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** HTML 片段 → 纯文本。只用于把摘要转成可安全展示的文字，不做富文本保留。 */
export function htmlToText(input: string): string {
  if (!input) return '';
  const withoutHidden = input
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|iframe|object)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|iframe|object)\b[^>]*\/?>/gi, ' ');
  const withBreaks = withoutHidden
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n· ');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return decodeEntities(stripped)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTrackingParam(name: string): boolean {
  return TRACKING_PARAMS.some((pattern) => pattern.test(name));
}

/**
 * 规范化 URL：小写主机、去掉默认端口与锚点、丢弃跟踪参数、参数排序、去掉末尾斜杠。
 * 只接受 http/https 且不带账号密码的地址；失败返回 null。
 */
export function canonicalizeUrl(raw: string, base?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  url.hash = '';
  url.hostname = url.hostname.replace(/\.$/, '').toLowerCase();

  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if (!isTrackingParam(key)) kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/** 图片等附属资源：只校验协议，不改写参数（很多图床靠查询参数授权） */
export function httpUrlOrNull(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  try {
    const url = base ? new URL(raw.trim(), base) : new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 内容指纹：标题 + 摘要。不含时间，避免 Feed 每次输出格式不同被判成新文章。 */
export function contentHash(title: string, summary: string | null): string {
  const normalized = `${title}\n${summary ?? ''}`.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** 发布时间的宽松解析：只接受能解析的值，其余一律当缺失 */
export function parseTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const time = Date.parse(raw.trim());
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
