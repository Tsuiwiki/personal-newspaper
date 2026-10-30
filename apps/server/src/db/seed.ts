import { openDatabase } from './index.js';
import { tableCount } from './index.js';
import { logger } from '../logger.js';
import { DEFAULT_THEME, type LayoutType } from '@paper/shared';

const log = logger.child('seed');

function isoDaysAgo(days: number, hour = 9): string {
  const date = new Date(Date.now() - days * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

interface SeedSource {
  name: string;
  type: 'rss' | 'atom' | 'manual';
  url: string;
  siteUrl: string;
  enabled?: boolean;
  lastFetchedAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
}

const sources: SeedSource[] = [
  {
    name: '少数派',
    type: 'rss',
    url: 'https://sspai.com/feed',
    siteUrl: 'https://sspai.com',
    lastFetchedAt: isoHoursAgo(3),
    lastStatus: 'ok',
  },
  {
    name: '阮一峰的网络日志',
    type: 'atom',
    url: 'https://www.ruanyifeng.com/blog/atom.xml',
    siteUrl: 'https://www.ruanyifeng.com/blog/',
    lastFetchedAt: isoHoursAgo(5),
    lastStatus: 'ok',
  },
  {
    name: 'Hacker News 前 30',
    type: 'rss',
    url: 'https://news.ycombinator.com/rss',
    siteUrl: 'https://news.ycombinator.com',
    lastFetchedAt: isoHoursAgo(1),
    lastStatus: 'ok',
  },
  {
    name: '纸上笔记',
    type: 'rss',
    url: 'https://paper-notes.dev/feed.xml',
    siteUrl: 'https://paper-notes.dev',
    lastFetchedAt: isoHoursAgo(20),
    lastStatus: 'error',
    lastError: '连接超时（15s）：域名解析成功，但对方未在超时时间内响应',
  },
  {
    name: '数据库内核观察（公众号）',
    type: 'manual',
    url: 'https://mp.weixin.qq.com/',
    siteUrl: 'https://mp.weixin.qq.com',
    enabled: false,
    lastFetchedAt: null,
    lastStatus: 'disabled',
  },
];

interface SeedArticle {
  sourceName: string | null;
  title: string;
  author: string | null;
  publishedAt: string;
  summary: string;
  contentText?: string;
  imageUrl?: string;
  accessLevel: 'link_only' | 'metadata' | 'user_provided';
  segment: string;
  layout: LayoutType;
  readingStatus?: 'unread' | 'read' | 'later';
}

const articles: SeedArticle[] = [
  {
    sourceName: '纸上笔记',
    title: '把订阅源收进一份报纸：信息降噪的六周实验',
    author: '林间',
    publishedAt: isoHoursAgo(4),
    summary:
      '每天打开十七个标签页，关上时几乎什么都没留下。六周前我把所有订阅收进一份每天只出一期的“报纸”，最大的变化不是读得更快，而是终于知道哪一篇值得读完。',
    imageUrl: '/media/card-notes.svg',
    accessLevel: 'metadata',
    segment: '头版',
    layout: 'headline',
    readingStatus: 'read',
  },
  {
    sourceName: '数据库内核观察（公众号）',
    title: 'SQLite 在个人项目里的边界：什么时候该换掉它',
    author: '内核观察',
    publishedAt: isoHoursAgo(7),
    summary:
      '单写多读、进程内嵌、WAL 模式下并发读写 —— SQLite 撑得住绝大多数个人应用。真正的分水岭不在数据量，而在“是否有多台机器要同时写”。',
    imageUrl: 'https://img.example.invalid/expired-cover.jpg',
    accessLevel: 'link_only',
    segment: '头版',
    layout: 'headline',
    readingStatus: 'later',
  },
  {
    sourceName: '少数派',
    title: '浏览器里的阅读排版正在变好',
    author: 'Sam',
    publishedAt: isoHoursAgo(11),
    summary:
      '从 text-wrap: pretty 到 CSS 的 hanging punctuation，浏览器终于开始关心一段中文里的标点该不该出头。这些细节单看都很小，叠起来决定了一屏字能不能被读完。',
    accessLevel: 'metadata',
    segment: '头版',
    layout: 'headline',
  },

  {
    sourceName: '数据库内核观察（公众号）',
    title: 'MySQL 8.4 LTS 的三个默认值变化',
    author: '内核观察',
    publishedAt: isoHoursAgo(9),
    summary:
      '默认值的变化比新特性更容易踩坑：字符集、认证插件和 binlog 相关参数在 8.4 里都换了默认，升级前先跑一遍差异清单。',
    imageUrl: '/media/card-db.svg',
    accessLevel: 'metadata',
    segment: '数据库观察',
    layout: 'double',
  },
  {
    sourceName: '数据库内核观察（公众号）',
    title: '为什么你的慢查询在从库上更快',
    author: '内核观察',
    publishedAt: isoHoursAgo(14),
    summary:
      '同样的 SQL、同样的数据，从库有时反而更快。缓存命中、页预热、以及主库上那批你根本看不见的并发写，都会改变执行计划的实际代价。',
    accessLevel: 'metadata',
    segment: '数据库观察',
    layout: 'double',
  },
  {
    sourceName: 'Hacker News 前 30',
    title: 'B+ 树分裂点不是你以为的那个地方',
    author: 'hn / lexicalscope',
    publishedAt: isoHoursAgo(18),
    summary:
      '自增主键的插入点永远在最右侧页，所以分裂大多数时候只发生在一条路径上。这解释了为什么“顺序写”的 B+ 树比随机写省一半的页分裂。',
    accessLevel: 'metadata',
    segment: '数据库观察',
    layout: 'double',
  },
  {
    sourceName: '阮一峰的网络日志',
    title: '一条 UPDATE 走了 12 秒：锁等待排查笔记',
    author: '阮一峰',
    publishedAt: isoHoursAgo(26),
    summary:
      '从 information_schema.innodb_trx 里揪出持锁的那个事务，再顺着 performance_schema 找到它到底卡在哪个语句上。多数“数据库很慢”其实是某个被遗忘的长事务。',
    accessLevel: 'metadata',
    segment: '数据库观察',
    layout: 'double',
  },

  {
    sourceName: '纸上笔记',
    title: '读到第 300 篇之后：我把 RSS 重新装回了浏览器',
    author: '林间',
    publishedAt: isoDaysAgo(1, 21),
    summary:
      '推荐流的问题不是信息多，而是它不告诉你“今天讲完了”。RSS 这份协议二十年没变，却恰好保留了“一期读完”的节奏。',
    imageUrl: '/media/feature-archive.svg',
    contentText: `我删掉过三次 RSS 阅读器。理由每次都很像：订阅太多，未读数越滚越大，最后变成一个不敢点开的小红点。

第四次装回来的时候，我换了个用法：不再按来源读，而是每天只编一期。

具体做法很朴素。早上七点，脚本把过去二十四小时里所有新条目收进数据库，按我事先定好的栏目分配：头版三条、数据库观察四条、深读两篇、简讯若干。超过十五篇的部分留在库里，等第二天再说。然后我打开的就是一份只有十五篇文章的“报纸”，从头版读到简讯，通常二十分钟。

这个做法最重要的改变，是不再有“我还要读完所有订阅”的幻觉。一份报纸读完了就是读完了，剩下的内容不是我欠下的债，而是明天的候选。

随之消失的还有另一种焦虑：我过去总在怀疑自己漏掉了什么。现在每晚睡前三分钟翻一眼文章库，标题列表摆在那里，值不值得点开一眼就知道——摘要的作用就是这个，它帮我判断要不要深入，而不是替我把文章读完。

也不是没有问题。第一周我编得过于贪心，每栏都想塞满，结果一期三十篇，读到第三天就不想打开了。容量上限这件事必须写死，十五篇是我目前的平衡点。第二周我又发现，“无新刊”其实是个好状态：那天 RSS 里确实没什么值得读的，报纸就该薄一点，甚至空一期。

三百篇之后，我对“信息过载”这个说法有了点不同的理解。过载的不是信息量，而是没有边界。报纸这种形态最值钱的地方，从来不是纸，是它每天都有一个明确的结束。`,
    accessLevel: 'user_provided',
    segment: '深读',
    layout: 'feature',
    readingStatus: 'read',
  },
  {
    sourceName: '少数派',
    title: '自建服务的十年账本：从折腾到够用',
    author: '邱天',
    publishedAt: isoDaysAgo(2, 10),
    summary:
      '跑了十年的家庭服务器，最后留下来的只有四样东西：文件、照片、订阅和一份数据库。把这四件事做稳，比再装十个容器有用得多。',
    imageUrl: '/media/feature-server.svg',
    contentText: `十年前买的第一台小主机，装的是一套“全套方案”：媒体库、下载器、笔记、网盘、监控、博客，能想到的都装了进去。那两年我花在维护上的时间，比使用它的时间还长。

转折点是一次硬盘故障。备份策略写得漂漂亮亮，但真到恢复的时候才发现，备份里缺了配置目录，而那套配置我改过十几版，早就记不清了。三天时间，我重建了一个“能跑起来”的版本，然后删掉了其中一半的服务。

从那以后，我给自己定了一条规矩：只保留每天真的会用到的服务，其余的一律用现成的托管服务代替。折腾的成本是有利息的，它不会一次把你击倒，但会持续消耗你。

第二个变化是数据的分层。现在我的数据只有两种：可以重建的，和不能重建的。订阅、索引、缓存都属于前者，坏了重新生成就好；照片、笔记、数据库属于后者，必须有异地副本，而且每季度真的恢复一次。恢复演练这件事听起来很重，实际上就是在一台干净的机器上跑一遍脚本，半小时的事。

第三个变化最不起眼，却最省心：所有服务共用一个数据库，每天凌晨自动备份，备份文件按日期留三十份。听上去很土，但十年下来，它救过我四次。

现在这台机器上只跑四样东西：文件同步、照片索引、一个 RSS 采集器，以及这份报纸的生成脚本。加起来内存占用不到 1G。够用，真的够用。`,
    accessLevel: 'user_provided',
    segment: '深读',
    layout: 'feature',
  },

  {
    sourceName: '少数派',
    title: '把纸质阅读的节奏搬进网页：栏宽、行高与字距',
    author: 'Sam',
    publishedAt: isoHoursAgo(13),
    summary:
      '中文正文的舒适行宽大约在 30 到 40 字之间，行高在 1.8 上下。多栏排版的难点从来不是栏数，而是让读者在换行、换栏时不迷路。',
    accessLevel: 'metadata',
    segment: '产品与工具',
    layout: 'list',
  },
  {
    sourceName: 'Hacker News 前 30',
    title: 'Hacker News 的极简为何仍然有效',
    author: 'hn / tomp',
    publishedAt: isoHoursAgo(22),
    summary:
      '一个表格、两行文字、没有图片。它证明了一件事：在信息密度足够高的场景里，装饰是成本，不是价值。',
    accessLevel: 'metadata',
    segment: '产品与工具',
    layout: 'list',
  },
  {
    sourceName: '阮一峰的网络日志',
    title: '用一行 CSS 做首字下沉',
    author: '阮一峰',
    publishedAt: isoDaysAgo(1, 8),
    summary:
      '::first-letter 加上 float 和一点行高微调就能做出像样的首字下沉，但中文标点会被吞进下沉块里，需要额外的边距补偿。',
    accessLevel: 'metadata',
    segment: '产品与工具',
    layout: 'list',
  },
  {
    sourceName: '纸上笔记',
    title: '键盘优先的阅读界面设计清单',
    author: '林间',
    publishedAt: isoDaysAgo(2, 20),
    summary:
      'j/k 翻条目、空格翻页、g 回顶、esc 退出。最重要的不是快捷键多，而是焦点始终可见，并且不会把读者弹到页面之外。',
    accessLevel: 'metadata',
    segment: '产品与工具',
    layout: 'list',
  },

  {
    sourceName: '数据库内核观察（公众号）',
    title: '一条命令备份 SQLite：.backup 与 VACUUM INTO 的区别',
    author: '内核观察',
    publishedAt: isoHoursAgo(6),
    summary:
      '直接复制 .db 文件在 WAL 模式下可能拿到不完整的快照；.backup 走的是在线备份接口，VACUUM INTO 顺带整理了碎片。',
    accessLevel: 'metadata',
    segment: '简讯',
    layout: 'brief',
  },
  {
    sourceName: '纸上笔记',
    title: '把摘要截断在句号处，而不是第 120 个字',
    author: '林间',
    publishedAt: isoHoursAgo(8),
    summary: '按标点截断比按字数截断可读性高得多，代价是要处理省略号和引号配对。',
    accessLevel: 'metadata',
    segment: '简讯',
    layout: 'brief',
  },
  {
    sourceName: '阮一峰的网络日志',
    title: '字体里的行高不是 CSS 的 line-height',
    author: '阮一峰',
    publishedAt: isoHoursAgo(16),
    summary: '字体的 ascender/descender 决定了视觉行高，CSS 的 line-height 只是行盒高度，两者相差能到 20%。',
    accessLevel: 'metadata',
    segment: '简讯',
    layout: 'brief',
  },
  {
    sourceName: 'Hacker News 前 30',
    title: '打印样式表：分页符与避免孤行',
    author: 'hn / simonw',
    publishedAt: isoHoursAgo(19),
    summary: 'break-inside: avoid 用在卡片上，orphans/widows 用在段落上，两行 CSS 就能让打印版干净很多。',
    accessLevel: 'metadata',
    segment: '简讯',
    layout: 'brief',
  },
  {
    sourceName: '少数派',
    title: '深色模式不要直接反色',
    author: 'Sam',
    publishedAt: isoHoursAgo(28),
    summary: '把纸白反成纯黑会让字重虚高；用深暖灰打底、降低对比度上限，阅读疲劳会明显下降。',
    accessLevel: 'metadata',
    segment: '简讯',
    layout: 'brief',
  },
];

const sections: Array<{ name: string; layoutType: LayoutType; maxArticles: number }> = [
  { name: '头版', layoutType: 'headline', maxArticles: 3 },
  { name: '数据库观察', layoutType: 'double', maxArticles: 4 },
  { name: '深读', layoutType: 'feature', maxArticles: 2 },
  { name: '产品与工具', layoutType: 'list', maxArticles: 4 },
  { name: '简讯', layoutType: 'brief', maxArticles: 6 },
];

async function seed(): Promise<void> {
  const db = await openDatabase();

  if (tableCount(db, 'issues') > 0) {
    log.info('数据库里已有期刊，跳过示例数据写入', { issues: tableCount(db, 'issues') });
    db.close();
    return;
  }

  const insertSource = db.prepare(
    `INSERT INTO sources (name, type, url, site_url, enabled, last_fetched_at, last_status, last_error)
     VALUES (@name, @type, @url, @siteUrl, @enabled, @lastFetchedAt, @lastStatus, @lastError)`,
  );
  const insertArticle = db.prepare(
    `INSERT INTO articles
       (source_id, title, author, published_at, discovered_at, canonical_url, original_url, summary,
        content_text, image_url, content_hash, content_access_level)
     VALUES
       (@sourceId, @title, @author, @publishedAt, @discoveredAt, @canonicalUrl, @originalUrl, @summary,
        @contentText, @imageUrl, @contentHash, @accessLevel)`,
  );
  const insertReadingState = db.prepare(
    `INSERT INTO reading_states (article_id, status) VALUES (@articleId, @status)`,
  );
  const insertIssueArticle = db.prepare(
    `INSERT INTO issue_articles
       (issue_id, article_id, section_id, section_name, layout_type, sort_order, display_snapshot_json)
     VALUES
       (@issueId, @articleId, @sectionId, @sectionName, @layoutType, @sortOrder, @displaySnapshot)`,
  );

  const result = db.transaction(() => {
    const template = db
      .prepare(
        `INSERT INTO templates (name, masthead_title, subtitle, date_format, theme_json, is_default)
         VALUES (@name, @mastheadTitle, @subtitle, @dateFormat, @themeJson, 1)`,
      )
      .run({
        name: '古典头条（默认）',
        mastheadTitle: '纸间',
        subtitle: '示例数据 · 每天值得打开的一份报纸',
        dateFormat: 'YYYY年M月D日 dddd',
        themeJson: JSON.stringify(DEFAULT_THEME),
      });
    const templateId = Number(template.lastInsertRowid);

    const insertSection = db.prepare(
      `INSERT INTO template_sections (template_id, name, sort_order, layout_type, max_articles, sort_rule)
       VALUES (@templateId, @name, @sortOrder, @layoutType, @maxArticles, 'published_desc')`,
    );
    const sectionIds = new Map<string, number>();
    sections.forEach((section, index) => {
      const info = insertSection.run({ templateId, ...section, sortOrder: index });
      sectionIds.set(section.name, Number(info.lastInsertRowid));
    });

    const sourceIds = new Map<string, number>();
    for (const source of sources) {
      const info = insertSource.run({
        name: source.name,
        type: source.type,
        url: source.url,
        siteUrl: source.siteUrl,
        enabled: source.enabled === false ? 0 : 1,
        lastFetchedAt: source.lastFetchedAt ?? null,
        lastStatus: source.lastStatus ?? null,
        lastError: source.lastError ?? null,
      });
      sourceIds.set(source.name, Number(info.lastInsertRowid));
    }

    const issueDate = todayInShanghai();
    const issueSnapshot = {
      templateName: '古典头条（默认）',
      masthead: {
        title: '纸间',
        subtitle: '示例数据 · 每天值得打开的一份报纸',
        dateFormat: 'YYYY年M月D日 dddd',
      },
      theme: DEFAULT_THEME,
      sections: sections.map((section) => ({
        id: sectionIds.get(section.name) ?? null,
        name: section.name,
        layoutType: section.layoutType,
        maxArticles: section.maxArticles,
      })),
    };

    const issue = db
      .prepare(
        `INSERT INTO issues (issue_date, issue_number, template_id, template_snapshot_json, status, generated_at)
         VALUES (@issueDate, 1, @templateId, @snapshot, 'published', @generatedAt)`,
      )
      .run({ issueDate, templateId, snapshot: JSON.stringify(issueSnapshot), generatedAt: isoHoursAgo(1) });
    const issueId = Number(issue.lastInsertRowid);

    let sortOrder = 0;
    for (const article of articles) {
      const slug = article.title
        .replace(/[^\p{Script=Han}\w]+/gu, '-')
        .slice(0, 40)
        .toLowerCase();
      const url = `https://example.local/read/${encodeURIComponent(slug)}`;
      const info = insertArticle.run({
        sourceId: article.sourceName ? (sourceIds.get(article.sourceName) ?? null) : null,
        title: article.title,
        author: article.author,
        publishedAt: article.publishedAt,
        discoveredAt: article.publishedAt,
        canonicalUrl: url,
        originalUrl: url,
        summary: article.summary,
        contentText: article.contentText ?? null,
        imageUrl: article.imageUrl ?? null,
        contentHash: `seed-${sortOrder}-${slug.slice(0, 16)}`,
        accessLevel: article.accessLevel,
      });
      const articleId = Number(info.lastInsertRowid);

      insertIssueArticle.run({
        issueId,
        articleId,
        sectionId: sectionIds.get(article.segment) ?? null,
        sectionName: article.segment,
        layoutType: article.layout,
        sortOrder: sortOrder++,
        displaySnapshot: JSON.stringify({
          title: article.title,
          author: article.author,
          sourceName: article.sourceName,
          summary: article.summary,
          imageUrl: article.imageUrl ?? null,
          publishedAt: article.publishedAt,
        }),
      });

      if (article.readingStatus && article.readingStatus !== 'unread') {
        insertReadingState.run({ articleId, status: article.readingStatus });
      }
    }

    return { templateId, issueId, count: articles.length };
  })();

  log.info('示例数据已写入', result);
  db.close();
}

seed().catch((error) => {
  log.error('写入示例数据失败', { error });
  process.exit(1);
});
