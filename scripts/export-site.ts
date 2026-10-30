import Database from 'better-sqlite3';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { z } from 'zod';
import { isIP } from 'node:net';
import { copyFile, lstat, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAYOUT_TYPES, CONTENT_ACCESS_LEVELS } from '@paper/shared';
import { estimateReadMinutes, parseTemplateSnapshot } from '../apps/server/src/services/issue-service.js';
import type { PublishedArticle, PublishedSnapshot } from '../apps/web/src/published-data.js';

const displaySchema = z.object({
  title: z.string().optional(),
  author: z.string().nullable().optional(),
  sourceName: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
});
const rowSchema = z.object({
  id: z.number(), section_name: z.string(), layout_type: z.enum(LAYOUT_TYPES),
  display_snapshot_json: z.string(), title: z.string(), author: z.string().nullable(),
  source_name: z.string().nullable(), summary: z.string().nullable(),
  image_url: z.string().nullable(), published_at: z.string().nullable(),
  original_url: z.string(), content_text: z.string().nullable(),
  content_access_level: z.enum(CONTENT_ACCESS_LEVELS),
});

export function publicUrl(raw: string | null): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) || !host.includes('.') || /\.(local|localhost|invalid|test|internal)$/i.test(host)) return '';
    if ([...url.searchParams.keys()].some(key => /token|secret|password|api.?key|auth|signature|credential/i.test(key))) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function createPublishedSnapshot(db: Database.Database): PublishedSnapshot {
  return db.transaction(() => {
    const issues = db.prepare(`SELECT id, issue_date, issue_number, template_snapshot_json
      FROM issues WHERE status = 'published' ORDER BY issue_date DESC, id DESC`).all() as Array<{
        id: number; issue_date: string; issue_number: number; template_snapshot_json: string;
      }>;
    if (!issues.length) throw new Error('没有已出版的报纸，未生成站点。');
    const query = db.prepare(`SELECT a.id, ia.section_name, ia.layout_type, ia.display_snapshot_json,
      a.title, a.author, s.name AS source_name, a.summary, a.image_url, a.published_at,
      a.original_url, a.content_text, a.content_access_level
      FROM issue_articles ia JOIN articles a ON a.id = ia.article_id
      LEFT JOIN sources s ON s.id = a.source_id WHERE ia.issue_id = ? ORDER BY ia.sort_order, ia.id`);
    return {
      exportedAt: new Date().toISOString(),
      issues: issues.map(issue => {
        const template = parseTemplateSnapshot(issue.template_snapshot_json);
        const rows = z.array(rowSchema).parse(query.all(issue.id));
        const groups = new Map<string, { layoutType: typeof LAYOUT_TYPES[number]; articles: PublishedArticle[] }>();
        for (const row of rows) {
          const display = displaySchema.parse(JSON.parse(row.display_snapshot_json));
          const contentText = ['extracted', 'user_provided'].includes(row.content_access_level) ? row.content_text : null;
          const summary = display.summary === undefined ? row.summary : display.summary;
          const image = display.imageUrl === undefined ? row.image_url : display.imageUrl;
          const group = groups.get(row.section_name) ?? { layoutType: row.layout_type, articles: [] };
          group.articles.push({
            id: row.id,
            title: display.title ?? row.title,
            author: display.author === undefined ? row.author : display.author,
            sourceName: display.sourceName === undefined ? row.source_name : display.sourceName,
            publishedAt: display.publishedAt === undefined ? row.published_at : display.publishedAt,
            summary,
            imageUrl: image && /^\/media\/[a-zA-Z0-9_-]+\.(svg|png|jpe?g|webp)$/.test(image) ? image : publicUrl(image) || null,
            originalUrl: publicUrl(row.original_url),
            accessLevel: row.content_access_level,
            hasFullText: Boolean(contentText),
            readMinutes: estimateReadMinutes(contentText, summary),
            contentText,
            isSample: row.original_url.startsWith('https://example.local/'),
          });
          groups.set(row.section_name, group);
        }
        const names = [...new Set([...template.sections.map(section => section.name), ...groups.keys()])];
        return {
          id: issue.id,
          issueDate: issue.issue_date,
          issueNumber: issue.issue_number,
          masthead: { title: template.masthead.title, subtitle: template.masthead.subtitle, dateFormat: template.masthead.dateFormat },
          theme: template.theme,
          sections: names.flatMap(name => {
            const group = groups.get(name);
            if (!group) return [];
            const section = template.sections.find(item => item.name === name);
            return [{ sectionId: section?.id ?? null, name, layoutType: group.layoutType,
              maxArticles: section?.maxArticles ?? group.articles.length, articles: group.articles }];
          }),
        };
      }),
    };
  })();
}

/** 子路径部署（如 GitHub Pages 项目站点 /personal-newspaper/）时，站内图片要跟 base 一起挪 */
export function withBase(snapshot: PublishedSnapshot, base: string): PublishedSnapshot {
  if (base === '/') return snapshot;
  return {
    ...snapshot,
    issues: snapshot.issues.map(issue => ({
      ...issue,
      sections: issue.sections.map(section => ({
        ...section,
        articles: section.articles.map(article => article.imageUrl?.startsWith('/media/')
          ? { ...article, imageUrl: `${base}${article.imageUrl.slice(1)}` }
          : article),
      })),
    })),
  };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const webRoot = join(root, 'apps/web');
  const output = join(root, 'dist-site');
  const rawBase = process.env.PAPER_SITE_BASE ?? '/';
  if (!rawBase.startsWith('/') || !rawBase.endsWith('/')) throw new Error('PAPER_SITE_BASE 必须以 / 开头并以 / 结尾。');
  const base = rawBase;
  const db = new Database(join(root, 'data/newspaper.db'), { readonly: true, fileMustExist: true });
  let snapshot: PublishedSnapshot;
  try { snapshot = createPublishedSnapshot(db); } finally { db.close(); }
  const media = new Set(snapshot.issues.flatMap(issue => issue.sections.flatMap(section =>
    section.articles.map(article => article.imageUrl).filter((url): url is string => Boolean(url?.startsWith('/media/'))))));
  for (const image of media) {
    const source = join(webRoot, 'public', image);
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('发布图片必须为普通文件。');
    if (image.endsWith('.svg') && /<script\b|\bon\w+\s*=|<foreignObject\b|(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:|javascript:)/i.test(await readFile(source, 'utf8'))) {
      throw new Error('发布图片包含活动内容或外部资源。');
    }
  }
  snapshot = withBase(snapshot, base);
  await build({
    configFile: false,
    root: webRoot,
    base,
    publicDir: false,
    plugins: [vue(), {
      name: 'published-paper-data',
      resolveId: id => id === 'virtual:published-paper' ? '\0published-paper' : undefined,
      load: id => id === '\0published-paper' ? `export default ${JSON.stringify(snapshot)};` : undefined,
    }],
    build: { outDir: output, emptyOutDir: true, sourcemap: false, rollupOptions: { input: join(webRoot, 'published.html') } },
  });
  await rename(join(output, 'published.html'), join(output, 'index.html'));
  if (media.size) await mkdir(join(output, 'media'), { recursive: true });
  for (const image of media) await copyFile(join(webRoot, 'public', image), join(output, image));
  const articles = snapshot.issues.flatMap(issue => issue.sections.flatMap(section => section.articles));
  console.log(JSON.stringify({ base, issues: snapshot.issues.length, articles: articles.length,
    savedBodies: articles.filter(article => article.hasFullText).length, localImages: media.size }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
