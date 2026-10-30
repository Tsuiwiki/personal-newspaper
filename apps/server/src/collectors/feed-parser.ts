import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { htmlToText, httpUrlOrNull } from '../ingestion/normalize.js';

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

export interface FeedEntry {
  externalId: string | null;
  title: string;
  /** 已解析为绝对地址，只保留 http/https */
  link: string;
  author: string | null;
  /** UTC ISO 8601；缺失或无法解析时为 null */
  publishedAt: string | null;
  /** 纯文本摘要，已截断 */
  summary: string | null;
  imageUrl: string | null;
}

export interface ParsedFeed {
  format: 'rss' | 'atom';
  title: string | null;
  siteUrl: string | null;
  entries: FeedEntry[];
}

/** 单次采集最多处理的条目数，防止超大 Feed 拖垮进程 */
const MAX_ENTRIES = 300;
const MAX_SUMMARY_CHARS = 1200;
const MAX_ID_CHARS = 512;

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asNode(value: unknown): XmlNode | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as XmlNode) : null;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const node = asNode(value);
  if (!node) return '';
  const inner = node['#text'];
  if (typeof inner === 'string') return inner;
  return '';
}

function attrOf(value: unknown, name: string): string {
  const node = asNode(value);
  if (!node) return '';
  const attr = node[`@_${name}`];
  return typeof attr === 'string' ? attr : '';
}

function cleanText(value: unknown): string {
  return htmlToText(textOf(value)).replace(/\s+/g, ' ').trim();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

function parseDate(value: unknown): string | null {
  const raw = textOf(value).trim();
  if (!raw) return null;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

function firstImageInHtml(html: string, base: string): string | null {
  const match = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
  return match ? httpUrlOrNull(match[1]!, base) : null;
}

function pickImage(item: XmlNode, summaryHtml: string, link: string): string | null {
  for (const enclosure of asArray(item['enclosure'])) {
    const url = httpUrlOrNull(attrOf(enclosure, 'url'), link);
    const type = attrOf(enclosure, 'type');
    if (url && (type.startsWith('image/') || type === '')) return url;
  }
  for (const key of ['thumbnail', 'image', 'content']) {
    for (const node of asArray(item[key])) {
      const url = httpUrlOrNull(attrOf(node, 'url') || attrOf(node, 'href'), link);
      const type = attrOf(node, 'type');
      const medium = attrOf(node, 'medium');
      if (url && (type.startsWith('image/') || medium === 'image' || key !== 'content')) return url;
    }
  }
  return firstImageInHtml(summaryHtml, link);
}

function pickAtomLink(item: XmlNode, base: string): string | null {
  const candidates = asArray(item['link']);
  let fallback: string | null = null;
  for (const candidate of candidates) {
    const href = typeof candidate === 'string' ? candidate : attrOf(candidate, 'href');
    if (!href) continue;
    const url = httpUrlOrNull(href, base);
    if (!url) continue;
    const rel = typeof candidate === 'string' ? 'alternate' : attrOf(candidate, 'rel');
    if (rel === '' || rel === 'alternate') return url;
    fallback ??= url;
  }
  return fallback;
}

function pickAuthor(item: XmlNode): string | null {
  const creator = cleanText(item['creator']);
  if (creator) return creator;
  const author = item['author'];
  if (typeof author === 'string') return cleanText(author) || null;
  const node = asNode(author);
  if (node) {
    const name = cleanText(node['name']);
    if (name) return name;
  }
  return null;
}

function pickSummary(item: XmlNode): { html: string; text: string | null } {
  const html = textOf(item['description'] ?? item['summary'] ?? item['encoded']);
  const text = cleanText(html);
  return { html, text: text ? truncate(text, MAX_SUMMARY_CHARS) : null };
}

function buildEntry(item: XmlNode, base: string, link: string, externalId: string): FeedEntry | null {
  const title = cleanText(item['title']);
  if (!title) return null;

  const { html, text } = pickSummary(item);
  return {
    externalId: externalId ? truncate(externalId, MAX_ID_CHARS) : null,
    title: truncate(title, 300),
    link,
    author: pickAuthor(item),
    publishedAt: parseDate(item['pubDate'] ?? item['published'] ?? item['updated'] ?? item['date']),
    summary: text,
    imageUrl: pickImage(item, html, link),
  };
}

function parseRss(doc: XmlNode, base: string): ParsedFeed {
  const rss = asNode(doc['rss']);
  const rdf = asNode(doc['RDF']);
  // RSS 2.0 的 channel 在 rss 里，RDF 的 channel 在根节点内，item 则是 RDF 根的直接子节点
  const channel = rss ? asNode(rss['channel']) : rdf ? asNode(rdf['channel']) : asNode(doc['channel']);
  const items = [...asArray(channel?.['item']), ...asArray(rdf?.['item'])];

  const siteUrl = channel
    ? httpUrlOrNull(textOf(channel['link']), base)
    : null;

  const entries: FeedEntry[] = [];
  for (const raw of items.slice(0, MAX_ENTRIES)) {
    const item = asNode(raw);
    if (!item) continue;
    const link = httpUrlOrNull(textOf(item['link']), base);
    if (!link) continue;
    const guidNode = item['guid'];
    const guid = textOf(guidNode).trim();
    const entry = buildEntry(item, base, link, guid);
    if (entry) entries.push(entry);
  }

  return {
    format: 'rss',
    title: channel ? cleanText(channel['title']) || null : null,
    siteUrl,
    entries,
  };
}

function parseAtom(doc: XmlNode, base: string): ParsedFeed {
  const feed = asNode(doc['feed']);
  if (!feed) throw new FeedParseError('不是有效的 Atom Feed');

  const feedLinks = asArray(feed['link']);
  let siteUrl: string | null = null;
  for (const link of feedLinks) {
    const href = typeof link === 'string' ? link : attrOf(link, 'href');
    const rel = typeof link === 'string' ? 'alternate' : attrOf(link, 'rel');
    if (href && (rel === '' || rel === 'alternate')) {
      siteUrl = httpUrlOrNull(href, base);
      if (siteUrl) break;
    }
  }

  const entries: FeedEntry[] = [];
  for (const raw of asArray(feed['entry']).slice(0, MAX_ENTRIES)) {
    const item = asNode(raw);
    if (!item) continue;
    const link = pickAtomLink(item, base);
    if (!link) continue;
    const id = cleanText(item['id']).trim();
    const entry = buildEntry(item, base, link, id);
    if (entry) entries.push(entry);
  }

  return {
    format: 'atom',
    title: cleanText(feed['title']) || null,
    siteUrl,
    entries,
  };
}

/** 解析 RSS 2.0 / RSS 1.0(RDF) / Atom。baseUrl 用于把相对链接补成绝对地址。 */
export function parseFeed(xml: string, baseUrl: string): ParsedFeed {
  const body = xml.replace(/^\uFEFF/, '').trim();
  if (!body) throw new FeedParseError('响应是空的');
  if (/^<!doctype html/i.test(body) || /^<html[\s>]/i.test(body)) {
    throw new FeedParseError('返回的是网页而不是 Feed，这个地址可能不是 RSS/Atom');
  }

  const validation = XMLValidator.validate(body);
  if (validation !== true) {
    throw new FeedParseError(`XML 解析失败：${validation.err.msg}（第 ${validation.err.line} 行）`);
  }

  let doc: XmlNode;
  try {
    doc = parser.parse(body) as XmlNode;
  } catch (cause) {
    throw new FeedParseError(cause instanceof Error ? cause.message : 'XML 解析失败');
  }

  if (doc['feed'] !== undefined) return parseAtom(doc, baseUrl);
  if (doc['rss'] !== undefined || doc['RDF'] !== undefined) return parseRss(doc, baseUrl);
  throw new FeedParseError('无法识别的 Feed 格式，只支持 RSS 2.0 / RSS 1.0 / Atom');
}
