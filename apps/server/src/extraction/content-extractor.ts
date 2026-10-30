import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { htmlToText } from '../ingestion/normalize.js';
import {
  GuardError,
  safeFetch,
  type SafeFetchOptions,
  type SafeFetchResult,
  type UrlPolicy,
} from '../security/url-guard.js';

export type ExtractErrorCode =
  | 'E_EXTRACT_UNSUPPORTED'
  | 'E_EXTRACT_HTTP'
  | 'E_EXTRACT_ACCESS_DENIED'
  | 'E_EXTRACT_RATE_LIMITED'
  | 'E_EXTRACT_EMPTY'
  | 'E_EXTRACT_TOO_SHORT'
  | 'E_EXTRACT_FAILED';

export class ExtractError extends Error {
  constructor(
    readonly code: ExtractErrorCode | string,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractError';
  }
}

export interface ExtractorDeps {
  /** 便于测试注入；默认走带 SSRF 防护的 safeFetch */
  fetchImpl?: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
  /** 测试里放行本地地址用；生产不要传 */
  urlPolicy?: UrlPolicy;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ExtractOptions extends ExtractorDeps {
  /** 低于这个字数视为“没读到正文”，不让导航和版权声明冒充正文 */
  minCharacters?: number;
  /** 单篇最多保存的纯文本字数 */
  maxCharacters?: number;
  /** 文章标题；页面标题与 h1 写法不一致时，用来去掉正文开头重复的标题 */
  title?: string;
}

export interface ExtractedContent {
  text: string;
  /** 不含空白的字符数 */
  characters: number;
  truncated: boolean;
  /** Readability 失败后改用页面主区块兜底 */
  usedFallback: boolean;
}

const DEFAULT_MIN_CHARACTERS = 280;
const DEFAULT_MAX_CHARACTERS = 60_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

const HTML_ACCEPT = 'text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5';
const MAIN_BLOCK_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '.post-content',
  '.article-content',
  '.entry-content',
  '.content',
  '#content',
];

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function countCharacters(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeText(raw: string, titles: Array<string | null | undefined>): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter(Boolean);

  // 正文第一行常和页面标题重复（Readability 标题、页面 h1、文章标题都可能不同），逐行去掉
  const known = new Set(titles.map((title) => squash(title ?? '')).filter(Boolean));
  while (lines.length > 0 && known.has(squash(lines[0] ?? ''))) lines.shift();
  return lines.join('\n\n');
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (countCharacters(text) <= max) return { text, truncated: false };

  const kept: string[] = [];
  let used = 0;
  for (const paragraph of text.split('\n\n')) {
    const size = countCharacters(paragraph);
    if (used + size > max) {
      if (kept.length === 0) {
        return { text: paragraph.slice(0, max).trim(), truncated: true };
      }
      break;
    }
    kept.push(paragraph);
    used += size;
  }
  return { text: kept.join('\n\n').trim(), truncated: true };
}

/** Readability 读不到时，从最常见的主内容容器里救一次；宁可失败，也不把整页导航当正文 */
function mainBlockHtml(document: Document): string | null {
  let best: Element | null = null;
  let bestLength = 0;
  for (const selector of MAIN_BLOCK_SELECTORS) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const length = squash(element.textContent ?? '').length;
      if (length > bestLength) {
        best = element;
        bestLength = length;
      }
    }
  }
  return best && bestLength > 0 ? best.innerHTML : null;
}

export function describeExtractError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '正文提取失败';
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * 从公开 HTML 页面提取正文纯文本。
 * 只读目标页面本身，不执行脚本、不带 Cookie；失败一律抛 ExtractError，由调用方回退到已有元数据。
 */
export async function extractArticleBody(url: string, options: ExtractOptions = {}): Promise<ExtractedContent> {
  const minCharacters = options.minCharacters ?? DEFAULT_MIN_CHARACTERS;
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const fetchImpl = options.fetchImpl ?? safeFetch;

  let response: SafeFetchResult;
  try {
    response = await fetchImpl(url, {
      ...(options.urlPolicy ?? {}),
      accept: HTML_ACCEPT,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxRedirects: 3,
    });
  } catch (cause) {
    if (cause instanceof GuardError) throw new ExtractError(cause.code, cause.message);
    throw new ExtractError('E_EXTRACT_FAILED', describeExtractError(cause));
  }

  if (response.status === 401 || response.status === 403) {
    throw new ExtractError(
      'E_EXTRACT_ACCESS_DENIED',
      `原文返回 HTTP ${response.status}，可能需要登录或被站点限制，已停止提取`,
    );
  }
  if (response.status === 429) {
    throw new ExtractError('E_EXTRACT_RATE_LIMITED', '原文要求降低访问频率（HTTP 429），请稍后再试');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ExtractError('E_EXTRACT_HTTP', `原文返回 HTTP ${response.status}`);
  }

  const contentType = headerValue(response.headers['content-type'])?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new ExtractError('E_EXTRACT_UNSUPPORTED', '原文不是 HTML 页面，无法提取正文');
  }
  const body = response.body;
  if (!body.trim() || body.includes('\u0000')) {
    throw new ExtractError('E_EXTRACT_UNSUPPORTED', '原文不是可解析的 HTML 页面');
  }

  let document: Document;
  try {
    document = parseHTML(body).document as unknown as Document;
  } catch {
    throw new ExtractError('E_EXTRACT_FAILED', '原文 HTML 无法解析');
  }

  const pageHeading = document.querySelector('h1')?.textContent ?? '';
  const parsed = new Readability(document, { charThreshold: 100, keepClasses: false }).parse();
  let raw = parsed?.content ? htmlToText(parsed.content) : '';
  let usedFallback = false;
  if (countCharacters(raw) < minCharacters) {
    const fallback = mainBlockHtml(document);
    const fallbackText = fallback ? htmlToText(fallback) : '';
    if (countCharacters(fallbackText) > countCharacters(raw)) {
      raw = fallbackText;
      usedFallback = true;
    }
  }

  const normalized = normalizeText(raw, [parsed?.title, options.title, pageHeading]);
  const characters = countCharacters(normalized);
  if (characters === 0) {
    throw new ExtractError('E_EXTRACT_EMPTY', '页面上没有读到可保存的正文');
  }
  if (characters < minCharacters) {
    throw new ExtractError(
      'E_EXTRACT_TOO_SHORT',
      `页面上只读到 ${characters} 个字符，没有达到 ${minCharacters} 字的正文门槛`,
    );
  }

  const trimmed = truncate(normalized, maxCharacters);
  return {
    text: trimmed.text,
    characters: countCharacters(trimmed.text),
    truncated: trimmed.truncated,
    usedFallback,
  };
}
