# 数据模型

SQLite，单文件，WAL 模式。迁移脚本在 `apps/server/src/migrations/`，按文件名排序执行，
执行记录写在 `schema_migrations`。**迁移文件只增不改**：改历史迁移会让老库和代码对不上，
需要修正时新写一个迁移。

约定：

- 时间戳统一存 UTC ISO 8601 字符串（`2026-10-28T03:40:33.819Z`），展示时由前端本地化；
  与报纸日期相关的“今天”和时间窗按 `app_settings.schedule.timeZone` 计算（默认取 `.env` 的 `TZ`）。
- 布尔用 `0` / `1`，带 `CHECK`。
- 枚举一律用 `CHECK IN (...)` 兜底，和 `packages/shared` 里的常量保持一一对应。

## 关系概览

```
sources ──< articles ──< issue_articles >── issues
                │                            │
                └── reading_states           └── templates ──< template_sections
```

- 来源删除不删文章：`articles.source_id` 为 `ON DELETE SET NULL`，文章仍然可读。
- 期刊删除连带版面条目：`issue_articles.issue_id` 为 `ON DELETE CASCADE`。
- 文章被期刊引用后不能直接删：`issue_articles.article_id` 为 `ON DELETE RESTRICT`，避免历史期刊开天窗。

## 表

### `sources` — 订阅来源

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | TEXT | 展示名 |
| `type` | TEXT | `rss` / `atom` / `webpage` / `manual`，新增时由解析结果决定 |
| `url` | TEXT | 抓取地址，唯一索引 |
| `site_url` | TEXT | 站点首页，首次采集成功时从 Feed 补全，用于"前往原文"的兜底 |
| `enabled` | INTEGER | 停用的来源不参与批量采集，但可以手动「立即采集」 |
| `poll_interval_minutes` | INTEGER | 5–10080 分钟，目前只存配置；定时任务按全局 `collectTime` 统一采集，尚未按来源轮询 |
| `extract_content` | INTEGER | 0/1，采集到新文章后是否自动尝试提取公开正文；默认 0，只影响之后新入库的文章 |
| `last_fetched_at` / `last_status` / `last_error` | TEXT | 最近一次采集结果，失败原因直接展示在来源页（截断到 200 字） |
| `etag` / `last_modified` | TEXT | 条件请求用，命中 304 就只更新 `last_fetched_at`，不重新解析和入库 |

### `articles` — 文章

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | TEXT | 必填 |
| `original_url` | TEXT | 必填，原文地址（保留用户/Feed 给的原始形态） |
| `canonical_url` | TEXT | 归一化后的地址，**部分唯一索引**（忽略 NULL） |
| `external_id` | TEXT | Feed 条目的稳定 ID（`guid` / Atom `id`），与 `source_id` 组成部分唯一索引 |
| `content_hash` | TEXT | 标题+摘要的 SHA-256（忽略空白差异），**部分唯一索引**，用于跨来源去重 |
| `summary` | TEXT | 摘要。可能来自 Feed，也可能是用户提供的节选，界面必须标注来源 |
| `content_text` | TEXT | 站内可读正文纯文本；只有 `user_provided` / `extracted` 才应写入 |
| `content_html_sanitized` | TEXT | 预留字段，当前始终为 NULL：正文只保存纯文本，不落 HTML |
| `content_access_level` | TEXT | `link_only` / `metadata` / `user_provided` / `extracted`，决定页面怎么措辞 |
| `extracted_at` | TEXT | 最近一次成功提取公开正文的时间；用户自己提供的正文不写这里 |
| `extract_error` | TEXT | 最近一次提取失败的原因（截断到 200 字）；成功提取或保存手动正文后清空 |
| `image_url` | TEXT | 封面图；只接受 http/https，失效时前端降级为占位框 |
| `published_at` / `discovered_at` | TEXT | 发布时间可能缺失，发现时间一定有 |

判重策略：**标题不参与判重**。顺序是：

1. 同一来源内按 `external_id` 判重（`guid` / Atom `id` 比重写过的链接可靠）；
2. 再按 `canonical_url` 全局判重（转载同一链接不会重复入库）；
3. 最后按 `content_hash` 判重（同一篇被不同 URL 转载时兜底）。

命中任意一条都只计 `duplicates`，不更新已有文章，也不覆盖阅读状态。

## 采集是怎么跑的

1. `POST /api/sources` 新增时先抓一次：解析成功才落库，`type` / `site_url` 取自 Feed；
2. 采集请求带 `If-None-Match` / `If-Modified-Since`，304 只刷新 `last_fetched_at`；
3. 解析 RSS 2.0 / RSS 1.0(RDF) / Atom，单次最多取 300 条；摘要转纯文本并按 1200 字截断；
4. 入库在一个事务里完成，按上面的顺序逐条判重；
5. 任何失败（超时、DNS、HTTP 非 2xx、XML 坏掉）只写 `last_status='error'` 与 `last_error`，
   **不删除、不改动已有文章**；批量采集的失败不会连累其它来源。

手动收藏（`POST /api/articles/manual-link`）走同一张表：`canonical_url` 去重，
有摘要记 `metadata`，没有记 `link_only`，`content_text` 保持为空；之后可以单篇提取或粘贴正文。

### 正文提取与手动正文

正文是**可选增值数据**，失败不能影响采集和已有内容：

1. **触发**：文章页单篇手动提取；或来源开启 `extract_content` 时，每次采集结束后对本次新入库的文章
   按 id 顺序最多尝试 3 篇。已经入库的旧文章不会因为打开开关被回填。
2. **读取**：只用现有的 SSRF 守卫读原文 HTML（跳转逐次校验、12s 超时、3MB 上限），
   不执行脚本、不带 Cookie；401/403/429 直接停下，不尝试绕过。
3. **解析**：Readability 先找主体；读不到时退回 `article` / `main` / `[role=main]` 等主区块。
   只保存纯文本，正文至少 280 字才写入，单篇最多 60,000 字（超出截断并标记）。
4. **写入**：成功时 `content_access_level='extracted'`、写 `content_text` 与 `extracted_at`、清空
   `extract_error`；失败只写 `extract_error`，标题、摘要、链接和既有正文原样保留。
5. **用户正文优先**：`POST /api/articles/manual-content` 写入 `user_provided`，清空提取时间与错误。
   提取服务在 SQL 和接口两层都拒绝覆盖 `user_provided`。
6. **不存 HTML**：`content_html_sanitized` 保持 NULL，避免净化规则漏网；阅读页按空行切段渲染纯文本。
7. **自动提取限额**：每来源每次采集最多 3 篇、串行读取；失败不会自动重试，留给之后手动提取。
   采集状态在正文提取前就已记成功，提取异常不会把一次成功的采集改写成失败。

这满足 PRD 的来源级存储策略：默认不长期保存第三方全文，用户显式开启或单篇请求才读取；
原文失效时，已保存的元数据和原始链接仍然保留。

### `templates` / `template_sections` — 模板与栏目

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `templates` | `masthead_title`、`subtitle`、`date_format`、`theme_json`、`layout_json` | 报头与主题（纸张/墨色/字号/版心宽度），`is_default` 标记当前模板 |
| `template_sections` | `name`、`sort_order`、`layout_type`、`max_articles`、`filter_json`、`sort_rule` | 栏目。`layout_type` 五种：`headline` / `feature` / `double` / `list` / `brief`；`max_articles` 是每栏每期上限（1–30） |

`theme_json` 与 `packages/shared` 的 `ThemeSettings` 对应，前端启动时写进 CSS 变量，
所以改主题不需要改样式表；`DEFAULT_THEME` 与 `apps/web/src/styles/tokens.css` 的初始值保持一致。

几张 JSON 字段的形状：

- `templates.layout_json`：`{ "maxTotalArticles": 15 }`。沿用已有字段而不是新开设置表，
  含义是**每期总容量**（1–50）。缺失或损坏时回退 15。
- `template_sections.filter_json`：`{ "sourceIds": [1,3], "maxAgeDays": 7, "pinnedArticleIds": [12] }`，
  三个键都可缺省。`sourceIds` 为空表示不限来源；`maxAgeDays` 1–365，缺省 7；`pinnedArticleIds`
  只有 `manual` 排序用。
- `template_sections.sort_rule`：`published_desc`（默认，按发布时间倒序）/ `source_priority`
  （按 `filter_json.sourceIds` 的数组顺序，不在列表里的来源排后面）/ `manual`
  （置顶文章优先，其余按发布时间倒序）。

编辑模板时如果提交 `sections`，服务端在一个事务里删除旧栏目再整组插入，栏目 `id` 会重新分配。
**历史期刊不引用这些 `id`**，所以重排、改名、删栏目都不会改到已出的报纸。

### `issues` — 一期报纸

| 字段 | 说明 |
| --- | --- |
| `issue_date` + `issue_number` | 联合唯一。一天一期时 `issue_number` 恒为 1，补刊才会递增 |
| `template_id` | 可为空：模板删了，期刊还在 |
| `template_snapshot_json` | **生成当时的模板快照**：`templateName`、报头、主题、`maxTotalArticles`，以及每个栏目的 `id`/`name`/`layoutType`/`maxArticles`/`filter`/`sortRule` |
| `status` | `draft` / `published` / `failed`；生成默认写 `draft`，`publish` 时转 `published` |

生命周期：

1. **预览**（`POST /api/issues/preview`）不写任何表，只返回候选与入选结果。
2. **生成**在事务里写 `issues` + `issue_articles`，默认 `draft`。同一 `issue_date` 已有草稿时，
   必须显式 `replaceDraft` 才覆盖：更新 `issues` 行、删掉旧的 `issue_articles` 再重插。
3. **出版**只把 `status` 改成 `published`。出版后拒绝任何重生成（409），当天就是这一期。
4. 候选为空时不生成：不写 `issues`，前端显示"没有可排的文章"及原因。

### `issue_articles` — 版面条目

| 字段 | 说明 |
| --- | --- |
| `issue_id` / `article_id` | 联合唯一，同一篇在一期里只出现一次 |
| `section_id` | 指向 `template_sections`，**故意不设外键** |
| `section_name` / `layout_type` / `sort_order` | 版面快照：栏目改名、改版式、改顺序都不影响已出版的期刊 |
| `display_snapshot_json` | 生成当时展示用的标题、作者、来源名、摘要、封面、发布时间，供将来换稿/审计使用；当前渲染仍以 `articles` 表为准 |

**为什么快照要冗余存**：历史期刊必须按"当时的样子"读。如果渲染时去 join 当前模板，
把"数据库观察"从双栏改成列表后，上个月的报纸会跟着变版——这违反 PRD 对历史稳定性的要求。

**为什么 `section_id` 不加外键**：栏目被删掉后，历史期刊的条目仍要能显示。加外键要么阻止删栏目，
要么级联删文章，两者都不可接受。所以读取时按 `issue_articles.section_name` 归组（名称本身就是快照），
再按快照里的栏目顺序排列；快照里找不到的栏目作为孤立栏目追加在末尾，空栏目直接不渲染。

### `reading_states` — 阅读状态

| 字段 | 说明 |
| --- | --- |
| `article_id` | 主键，一篇文章一条 |
| `status` | `unread` / `read` / `later` |
| `progress` | 0–1 或 NULL，预留给长文进度 |
| `note` | 个人笔记，最多 4000 字（接口校验） |

单独成表而不是塞进 `articles`：阅读状态是"我"的数据，采集重跑、正文更新时不应该被覆盖。
两个字段独立更新：只改 `status` 不会覆盖已有 `note`，只存笔记也不会把状态改回未读；清空笔记写 `NULL`。

### `app_settings` — 运行时设置

| 字段 | 说明 |
| --- | --- |
| `key` | 主键。目前只有 `schedule` |
| `value_json` | 完整设置对象的 JSON |
| `updated_at` | 最近写入时间（UTC ISO） |

`schedule` 的形状与 `packages/shared` 的 `ScheduleSettings` 一致：

```json
{ "enabled": true, "collectTime": "07:00", "timeZone": "Asia/Shanghai",
  "autoGenerate": true, "publish": false }
```

- `collectTime` 是按 `timeZone` 的当地时间（`HH:MM`）；`timeZone` 是 IANA 名称。
- 读取时逐字段回退：JSON 损坏整条用默认值；单个字段类型或格式不对，只回退该字段，不连带整条设置。
  默认时区取 `.env` 的 `TZ`，所以**同一个数据库换机器不会悄悄改变“今天”**。
- 写入是 upsert，接口只做部分更新；值一旦写进库就与 `.env` 无关，`.env` 只影响新库的默认值。
- 设置存库而不是只放环境变量：定时配置需要在运行中修改，并且要跟同一个数据库一起备份、恢复。

### `job_runs` — 每日任务运行记录

| 字段 | 说明 |
| --- | --- |
| `job` | 目前恒为 `daily` |
| `trigger` | `schedule`（定时）或 `manual`（手动触发） |
| `run_date` | 任务归属的本地日期（设置时区下的 `YYYY-MM-DD`） |
| `status` | `running` / `ok` / `partial` / `failed`；`skipped` 保留未用 |
| `started_at` / `finished_at` | 起止时间（UTC ISO）；执行中 `finished_at` 为 `NULL` |
| `detail_json` | 结构化结果，见下 |

`detail_json` 的形状：

```json
{
  "sources": { "total": 4, "ok": 3, "failed": 1, "inserted": 5, "duplicates": 20,
    "results": [ /* 每个来源：SourceFetchResult + attempts */ ] },
  "issue": { "generated": true, "issueId": 7, "issueStatus": "draft", "total": 12,
    "reason": null, "message": "已生成预览稿 12 篇" },
  "note": "来源 4 个：成功 3，失败 1，新增 5 篇；已生成预览稿 12 篇"
}
```

- `sources` / `issue` 在任务还没走到那一步、或整轮异常时为 `null`。
- `issue.reason` 除了与预览相同的 `no_recent` / `all_used` / `filters`，还有 `draft_exists`
  （定时任务不覆盖已有草稿）、`issue_exists`（当天已出版）和 `error`。
- `attempts` 是该来源实际请求次数；定时任务对失败来源重试一次，手动「全部采集」不重试。

运行语义：

1. **抢当天名额**：开跑前插入一条 `running` 记录。唯一部分索引
   `idx_job_runs_schedule_day (job, run_date) WHERE trigger = 'schedule' AND status <> 'failed'`
   保证同一天最多一条有效的定时运行；插入冲突说明今天已经跑过，直接跳过。
2. **失败不占位**：`status='failed'` 的记录不满足索引条件，所以整轮失败后可以在 10 分钟冷却后重试。
   成功的定时运行会把下一次计算到明天的 `collectTime`。
3. **进程内互斥**：手动触发和定时任务共用同一把锁（进程内 `WeakSet`），撞上时接口返回 409；
   手动运行不按日期去重，可以一天跑多次。
4. **失败隔离**：单个来源失败只写该来源的结果，其它来源照常入库；整轮异常才把本次运行标成 `failed`。
5. **启动恢复**：进程退出时留下的 `running` 记录已经没有执行者，启动时统一改成 `failed`，
   `finished_at` 保留为原开始时间，备注写明中断；随后按冷却规则决定是否重试。
6. 定时任务只有在 `enabled=true` 且今天还没有有效运行记录、当前时刻已过 `collectTime` 时才启动；
   进程退出期间不会补跑，重启后只判断“今天”。

## 一期报纸是怎么生成出来的

编排逻辑在 `apps/server/src/services/issue-builder.ts`，预览与生成共用同一套代码——预览就是
"算完不写库"，避免预览说一套、保存后出另一套。

### 候选池

按以下条件一次取出候选，再在内存里按栏目分配：

```sql
WHERE (a.source_id IS NULL OR s.enabled = 1)
  AND 发布时间（缺失时用发现时间）落在时间窗内
  AND NOT EXISTS（该文章已被别的期次用过）
```

- **启用来源**与**手动收录**（`source_id IS NULL`）都算候选；停用来源不进池。
  删除来源后文章 `source_id` 变 NULL，因此仍可参与以后编排，也不会从往期消失。
- **时间窗**从 `issue_date` 在设置时区（`schedule.timeZone`，默认 `Asia/Shanghai`）的当地零点起算，向前推 N 天。
  全局窗口取 `max(7, 各栏目 maxAgeDays)`，先粗筛；每个栏目再用自己的 `maxAgeDays` 精筛。
  时间比较用 SQLite `julianday()`，避免字符串比较的时区歧义。
- **不重复用稿**：`issue_articles` 里只要被任何一期引用过就排除；正在替换的那一期除外，
  这样替换草稿能拿回它自己上次用过的文章。

### 分配顺序

1. 栏目按 `sort_order` 依次处理，**顺序就是优先级**。
2. 每个栏目按 `sort_rule` 排序（见上文），跳过已入选的文章。
3. 每栏最多取 `max_articles` 篇，同时不能超过整期剩余的 `maxTotalArticles` 容量。
4. 被栏目上限或全局容量挤掉的文章计入 `omitted`，前端会显示"另有 N 篇未排入"。

所以调整栏目顺序、栏目上限或整期容量，就能直接控制哪些内容上头版。

### 空池的处理

`total = 0` 时区分三种原因，只做解释、不硬凑：

| `emptyReason` | 含义 |
| --- | --- |
| `no_recent` | 时间窗内没有任何候选，也没有被用过的旧文章 |
| `all_used` | 窗口内有文章，但都已经被往期用过 |
| `filters` | 有候选，但被栏目的来源/时间筛选挡掉了 |

### 快照与历史稳定性

生成时把整个模板结构写进 `issues.template_snapshot_json`，版面条目另存 `section_name` /
`layout_type` / `sort_order`。渲染只读快照与 `issue_articles`，**不 join 当前模板**：之后改模板、
换默认模板、删栏目，上一期都保持原样。文章本身的标题/摘要在文章库里更新时，历史期次会跟着显示
最新元数据——版式与选稿不动，这是当前版本有意保留的边界。

## 期刊视图是怎么拼出来的

`GET /api/issues/latest` 之类返回的 `IssueView` 不是一张表，而是：

1. 读 `issues` 行，解析 `template_snapshot_json`（解析失败时退回内置默认值，不抛 500）；
2. 读该期 `issue_articles`，按 `sort_order` 排序后按栏目名归组；
3. 读 `articles` + `reading_states`（`LEFT JOIN`，没有记录就是 `unread`），算出 `hasFullText`（`content_text` 是否为空）和 `readMinutes`；
4. 快照里没有、但版面条目里存在的栏目，作为"孤立栏目"追加在末尾，保证旧期刊不丢内容；没有条目的栏目不渲染；
5. 统计 `total` / `read` / `later` 写在 `stats` 里，报头直接用。

`hasFullText` 是刻意和前端的措辞绑定的：没有正文时不能说"约 3 分钟"，只能说"仅有摘要"，否则就是骗读者点开。

## 索引

| 索引 | 用途 |
| --- | --- |
| `idx_sources_url`（唯一） | 同一地址不重复添加 |
| `idx_articles_canonical_url`（部分唯一） | 去重 |
| `idx_articles_content_hash`（部分唯一） | 跨来源去重 |
| `idx_articles_source_external`（部分唯一） | 同一来源按 Feed 稳定 ID 去重 |
| `idx_articles_published` | 文章库按时间倒序 |
| `idx_issue_articles_issue` | 按期刊 + 栏目 + 顺序取版面 |
| `idx_issues_date` | 期刊档案倒序 |
| `idx_reading_states_status` | 按"未读 / 稍后读"筛选 |
| `idx_job_runs_schedule_day`（部分唯一） | 同一天最多一条有效定时运行；失败记录不占位 |
| `idx_job_runs_started` | 运行记录按时间倒序 |

## 备份

迁移器在检测到待执行迁移时，先用 `better-sqlite3` 的 `db.backup()` 落一份到 `data/backups/`，
文件名带时间戳，备份失败就中止迁移。设置页的「立即备份」也走同一个在线备份接口，
恢复仍是手动步骤（停服务、替换 `data/newspaper.db`、清掉 `-wal` / `-shm`），详见根目录 README。

备份包含所有表，包括 `app_settings` 与 `job_runs`：恢复后定时配置和运行记录都会回来，
但“今天是否已跑过”的记录也一并恢复，所以恢复旧备份后调度器会按那份备份里的记录判断是否补跑。
