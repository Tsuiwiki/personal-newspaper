# 接口说明

Base URL：`http://127.0.0.1:8787/api`（端口见 `.env` 的 `PORT`）。
请求与响应都是 JSON；写请求必须带 `Content-Type: application/json`，否则 415。
请求体上限 1 MB。

前端开发时通过 Vite 代理 `/api` 到后端，所以页面里用同源相对路径即可。

## 约定

- 时间：UTC ISO 8601 字符串，如 `2026-10-28T03:40:33.819Z`。展示层负责转本地时区。
- 失败统一返回：

```json
{ "error": { "code": "E_NOT_FOUND", "message": "这篇文章不在文章库里" } }
```

| code | 状态码 | 场景 |
| --- | --- | --- |
| `E_VALIDATION` | 400 | 参数/请求体不合法，`details` 里带字段级原因 |
| `E_NOT_FOUND` | 404 | 文章、期刊、模板、来源或接口不存在 |
| `E_NO_TEMPLATE` | 409 | 生成/预览时没有任何模板，先去模板页建一个 |
| `E_DRAFT_EXISTS` | 409 | 当天已有草稿，替换需要显式 `replaceDraft: true` |
| `E_ISSUE_EXISTS` | 409 | 当天期刊已经出版，不能再改或重生成 |
| `E_ISSUE_FAILED` | 409 | 当天期刊处于 `failed` 状态，本版本不提供恢复入口 |
| `E_JOB_RUNNING` | 409 | 已有采集/生成任务在跑，手动触发被拒绝 |
| `E_UNSUPPORTED_MEDIA_TYPE` | 415 | 写请求没带 `application/json` |
| `E_HOST_NOT_ALLOWED` | 403 | `Host` 头不是本机地址（仅当服务只绑定回环时校验） |
| `E_ORIGIN_NOT_ALLOWED` | 403 | 写请求带了不在白名单里的 `Origin` |
| `E_SOURCE_EXISTS` | 409 | 同一个 Feed 地址已经添加过 |
| `E_SOURCE_NOT_FOUND` | 400 | 手动收录指定的 `sourceId` 不存在 |
| `E_FEED_INVALID` | 400 | 地址返回的不是可解析的 RSS/Atom（含 HTTP 非 2xx） |
| `E_URL_INVALID` | 400 | 手动收录的链接无法规范化（非 http/https、带凭据等） |
| `E_ARTICLE_EXISTS` | 409 | 手动收录的链接或内容已在文章库，`details.articleId` 指向已有文章 |
| `E_CONTENT_USER_PROVIDED` | 409 | 正文由用户提供，提取接口拒绝覆盖 |
| `E_FETCH_FAILED` | 502 | 立即采集失败，`details` 带 `sourceId` 与底层 `errorCode` |
| `E_INTERNAL` | 500 | 未预期错误，细节只写日志，不回传 |

`security/url-guard.ts` 里的拉取类错误（`E_URL_*`、`E_DNS_FAILED`、`E_URL_ADDRESS_BLOCKED`、
`E_REDIRECT_LIMIT`、`E_TIMEOUT`、`E_BODY_TOO_LARGE`、`E_NETWORK`）在新增/验证来源时以 400 原样返回；
在「立即采集」里会被包成 502 `E_FETCH_FAILED`，原始 code 放在 `details.errorCode`，同时写进来源的 `last_error`。

---

## `GET /api/health`

```json
{ "status": "ok", "version": "0.1.0", "time": "2026-10-28T03:41:41.795Z" }
```

## `GET /api/issues/latest`

返回最新一期（`published` 或 `draft`）。没有期刊时返回 `null`（HTTP 200），前端据此显示"还没有报纸"。

```json
{
  "id": 1,
  "issueDate": "2026-10-28",
  "issueNumber": 1,
  "status": "published",
  "generatedAt": "2026-10-28T02:40:33Z",
  "templateId": 1,
  "templateName": "古典头条（默认）",
  "masthead": { "title": "纸间", "subtitle": "示例数据 · 每天值得打开的一份报纸", "dateFormat": "YYYY年M月D日 dddd" },
  "theme": {
    "paper": "#f3eee2", "paperTexture": "grain", "ink": "#1c1a16", "inkMuted": "#544d3d",
    "rule": "#cabfa9", "accent": "#8a2b1e", "bodyFontSize": 17, "bodyLineHeight": 1.85, "contentWidth": 1180
  },
  "sections": [
    {
      "sectionId": 1,
      "name": "头版",
      "layoutType": "headline",
      "maxArticles": 3,
      "articles": [
        {
          "id": 1,
          "title": "把订阅源收进一份报纸：信息降噪的六周实验",
          "author": "林间",
          "sourceId": 4,
          "sourceName": "纸上笔记",
          "publishedAt": "2026-10-27T23:40:33Z",
          "summary": "每天打开十七个标签页……",
          "imageUrl": "/media/card-notes.svg",
          "originalUrl": "https://example.local/read/…",
          "accessLevel": "metadata",
          "readingStatus": "read",
          "hasFullText": false,
          "readMinutes": 1
        }
      ]
    }
  ],
  "stats": { "total": 18, "read": 2, "later": 1 }
}
```

字段含义见 [数据模型](DATA_MODEL.md#期刊视图是怎么拼出来的)。两点必须注意：

- `hasFullText=false` 时，界面只能说"仅有摘要 / 前往原文"，不能显示阅读时长；
- `sections` 已经是快照排序，前端按返回顺序渲染即可，空栏目不会出现。

## `GET /api/issues`

```json
{ "items": [{ "id": 1, "issueDate": "2026-10-28", "issueNumber": 1, "status": "published",
  "generatedAt": "2026-10-28T02:40:33Z", "articleCount": 18, "mastheadTitle": "纸间" }] }
```

按日期倒序。Phase 1 不分页（一天一期，一年 365 条，前端档案页先全量展示）。

## `GET /api/issues/:id`

与 `/api/issues/latest` 同一结构。`:id` 必须是正整数，否则 400；不存在返回 404 `E_NOT_FOUND`。

## `POST /api/issues/preview`

**只计算，不写库。** 请求体可为空；两个字段都可省略：

```json
{ "templateId": 1, "date": "2026-10-28" }
```

- `templateId` 缺省用默认模板；没有模板时 409 `E_NO_TEMPLATE`。
- `date` 缺省取**设置页时区**（默认来自 `.env` 的 `TZ`，即 `Asia/Shanghai`）的今天；
  格式 `YYYY-MM-DD`，不存在的日期 400。时间窗零点也按这个时区计算。
- `generate` 与 `preview` 用同一套规则，下面不再重复说明时区。

返回：

```json
{
  "issueDate": "2026-10-28",
  "templateId": 1,
  "templateName": "古典头条（默认）",
  "masthead": { "title": "纸间", "subtitle": "", "dateFormat": "YYYY年M月D日 dddd" },
  "theme": { /* ThemeSettings */ },
  "maxTotalArticles": 15,
  "sections": [{
    "sectionId": 1, "name": "头版", "layoutType": "headline", "maxArticles": 3,
    "articles": [ /* ArticleCard */ ],
    "matched": 5, "omitted": 2
  }],
  "total": 12,
  "candidates": { "fresh": 20, "used": 8, "eligible": 12 },
  "existingIssue": { "id": 3, "issueNumber": 3, "status": "draft" },
  "emptyReason": null
}
```

- `matched` 是该栏目筛选后命中数，`omitted` 是被栏目上限或全局容量挤掉的数量。
- `candidates.eligible` 是当前可参与编排的文章数，`used` 是窗口内已被别期用掉的数，`fresh` 是两者之和。
- `emptyReason`：`no_recent`（窗口内没有新文章）、`all_used`（有文章但都被往期用过）、
  `filters`（有候选，但被来源/时间窗筛掉）；`total > 0` 时为 `null`。
- `existingIssue` 非空表示当天已有期次，`generate` 会据此要求替换或拒绝。

## `POST /api/issues/generate`

请求体在 preview 基础上多两个布尔：

```json
{ "templateId": 1, "date": "2026-10-28", "replaceDraft": false, "publish": false }
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `replaceDraft` | `false` | 当天已有草稿时，是否覆盖它 |
| `publish` | `false` | `true` 直接生成并出版；默认存成草稿 |

行为：

- 新生成草稿返回 `201`；覆盖草稿返回 `200`，`replacedDraft: true`。
- 当天已出版 → 409 `E_ISSUE_EXISTS`；当天有草稿但没给 `replaceDraft` → 409 `E_DRAFT_EXISTS`。
- 候选池为空 → **不写库**，返回 `200` 且 `generated: false`，`reason` 同 preview 的 `emptyReason`。

```json
{
  "generated": true,
  "replacedDraft": false,
  "issue": { /* IssueView，同 /api/issues/:id */ },
  "preview": { /* 同 preview 响应 */ },
  "reason": null
}
```

返回里的 `preview` 是本次实际采用的编排结果，前端可以直接拿来显示"哪几篇被选入"。

## `POST /api/issues/:id/publish`

把草稿转成 `published`，返回更新后的 `IssueView`。

- 已是 `published`：直接返回当前内容（幂等），不改任何文章快照。
- `failed`：409 `E_ISSUE_FAILED`。
- 不存在：404。

## `GET /api/templates`

```json
{ "items": [{
  "id": 1, "name": "古典头条（默认）", "mastheadTitle": "纸间",
  "subtitle": "", "dateFormat": "YYYY年M月D日 dddd",
  "theme": { /* ThemeSettings */ },
  "maxTotalArticles": 15, "isDefault": true, "updatedAt": "2026-10-28T02:40:33Z",
  "sections": [{
    "id": 1, "name": "头版", "sortOrder": 0, "layoutType": "headline", "maxArticles": 3,
    "filter": { "sourceIds": [1, 3], "maxAgeDays": 7, "pinnedArticleIds": [12] },
    "sortRule": "source_priority"
  }]
}] }
```

`sortRule` 取 `published_desc` / `source_priority` / `manual`。`source_priority` 按 `filter.sourceIds`
数组顺序；`manual` 先排 `pinnedArticleIds`，其余仍按发布时间倒序（目前只有接口支持，界面未开放）。
`filter` 里字段可缺省：缺省表示不限来源、时间窗用默认 7 天、没有置顶。

## `POST /api/templates`

```json
{
  "name": "晨间版",
  "mastheadTitle": "纸间",
  "subtitle": "每天八点",
  "dateFormat": "YYYY年M月D日 dddd",
  "theme": { /* ThemeSettings，缺省用默认主题 */ },
  "maxTotalArticles": 15,
  "sections": [{
    "name": "头版", "layoutType": "headline", "maxArticles": 3,
    "filter": { "sourceIds": [1], "maxAgeDays": 3 }, "sortRule": "published_desc"
  }]
}
```

- `name` ≤ 60、`mastheadTitle` ≤ 40、`subtitle` ≤ 160、`dateFormat` ≤ 60；
  栏目 1–12 个，`name` 1–20 且不能重名，`maxArticles` 1–30，`maxTotalArticles` 1–50。
- 第一个模板自动成为默认模板。成功后 `201` 返回 `TemplateView`。
- 校验失败 400 `E_VALIDATION`，`details` 带字段路径。

## `PATCH /api/templates/:id`

部分更新，至少一个字段；字段约束同上。传 `sections` 时**整组替换**：

```json
{ "maxTotalArticles": 12, "sections": [ /* 新的完整栏目数组 */ ] }
```

- 模板行与栏目行在一个事务里更新；栏目 id 会重新分配。
- 历史期刊存的是自己的 `template_snapshot_json`，不受影响。
- 返回更新后的 `TemplateView`；不存在 404。

## `POST /api/templates/:id/copy`

复制模板及其栏目，名字自动加「副本」后缀并保证唯一。成功 `201`，返回新的 `TemplateView`
（`isDefault` 为 `false`）。不存在 404。

## `POST /api/templates/:id/default`

把该模板设为默认，同时清掉其它模板的默认标记（事务内完成）。返回该模板的 `TemplateView`。不存在 404。

## `GET /api/articles`

查询参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `page` | 1 | 页码 |
| `pageSize` | 20 | 每页条数，1–100 |
| `status` | — | `unread` / `read` / `later` |
| `sourceId` | — | 按来源筛选 |
| `q` | — | 标题/摘要模糊搜索，最长 200 字 |

```json
{ "items": [ /* ArticleCard */ ], "total": 18, "page": 1, "pageSize": 20 }
```

返回的 `items` 是 `ArticleCard`（同期刊里的卡片结构），不含正文。

## `GET /api/articles/:id`

返回 `ArticleDetail`，在卡片字段之外多了：

| 字段 | 说明 |
| --- | --- |
| `canonicalUrl` | 归一化地址，可能为 null |
| `discoveredAt` | 入库时间 |
| `summaryIsSystem` | 摘要是否来自 Feed/抓取（true 时界面必须标明"系统生成，非原文"） |
| `contentText` | 站内正文，只有 `user_provided` / `extracted` 才有 |
| `note` | 个人笔记 |
| `extractedAt` | 最近一次成功提取公开正文的时间；用户自己提供的正文不写这里 |
| `extractError` | 最近一次提取失败的原因；成功提取或保存手动正文后为 null |

## `PATCH /api/articles/:id/reading-state`

请求体至少给一个字段：

```json
{ "status": "read" }
```

| 字段 | 约束 |
| --- | --- |
| `status` | `unread` / `read` / `later` |
| `note` | 字符串，最长 4000，可为 `null` |
| `progress` | 0–1，可为 `null` |

返回更新后的完整 `ArticleDetail`。状态是覆盖写（`INSERT … ON CONFLICT DO UPDATE`），
不会因为采集重跑而丢失。文章不存在返回 404。

## `POST /api/articles/:id/extract`

立即从原文公开页面提取正文。请求体为空对象即可。

- 复用采集的 SSRF 守卫与跳转校验；超时 12s、响应体上限 3MB、最多 3 跳。
- 只接受 HTML；不执行脚本、不带 Cookie；401/403/429 视为访问限制，直接停止，不尝试绕过。
- 正文至少 280 字才写入；单篇最多保存 60,000 字（不含空白），超出部分截断。
- 成功写 `content_text`、`content_access_level='extracted'`、`extracted_at`，清空 `extract_error`。
- 失败**不删除**原有标题、摘要、链接和已存正文，只把原因写入 `extract_error`。
- `content_access_level='user_provided'` 时返回 `409 E_CONTENT_USER_PROVIDED`，绝不覆盖。

提取失败是预期内结果，HTTP 仍为 200：

```json
{
  "ok": false,
  "characters": 0,
  "truncated": false,
  "usedFallback": false,
  "error": { "code": "E_EXTRACT_ACCESS_DENIED", "message": "原文返回 HTTP 403，可能需要登录或被站点限制，已停止提取" },
  "article": { /* 更新后的 ArticleDetail，extractError 同步写入 */ }
}
```

成功时 `ok:true`、`error:null`，`characters` 是实际保存的非空白字符数，`truncated` 表示原文超长，
`usedFallback` 表示 Readability 没读到主体、改用页面主区块兜底。常见失败 code：
`E_EXTRACT_TOO_SHORT`、`E_EXTRACT_UNSUPPORTED`、`E_EXTRACT_HTTP`、`E_EXTRACT_ACCESS_DENIED`、
`E_EXTRACT_RATE_LIMITED`、`E_EXTRACT_EMPTY`，以及原样透传的 `E_URL_*` / `E_TIMEOUT` / `E_NETWORK`。

## `POST /api/articles/manual-content`

导入用户自己有权使用的正文纯文本。请求体：

```json
{ "articleId": 12, "content": "第一段……\n\n第二段……" }
```

- `content` 至少 20 个非空白字符，最多 200,000 字符；`\r\n` 会归一化为 `\n`，连续空行压到最多一空行。
- 写入 `content_text`，标记 `content_access_level='user_provided'`，清空 `extracted_at` / `extract_error`。
- 会替换该文章现有正文；之后的提取接口拒绝覆盖。
- 成功返回完整 `ArticleDetail`；文章不存在 404，内容不合法 400 `E_VALIDATION`。

## `GET /api/sources`

```json
{ "items": [{
  "id": 3, "name": "Hacker News 前 30", "type": "rss",
  "url": "https://news.ycombinator.com/rss", "siteUrl": "https://news.ycombinator.com",
  "enabled": true, "pollIntervalMinutes": 60, "extractContent": false,
  "lastFetchedAt": "2026-10-28T02:40:33Z", "lastStatus": "ok",
  "lastError": null, "articleCount": 3
}] }
```

排序：启用的在前，其余按名称。`lastStatus` 为 `ok` / `error` / `null`（还没采过）。

## `POST /api/sources`

新增订阅。**先用真实地址抓取并解析一次**，成功才落库，这一份结果同时用于入库，不会抓两次。

```json
{ "url": "https://example.com/feed.xml", "name": "可选，缺省用 Feed 标题", "pollIntervalMinutes": 60,
  "enabled": true, "extractContent": false }
```

- `url` 必填，必须是 http/https 且不带账号密码；`name` ≤ 80 字；`pollIntervalMinutes` 5–10080，默认 60。
- `extractContent` 默认 `false`：开启后，之后每次采集新入库的文章最多自动提取 3 篇公开正文。
- 类型（`rss` / `atom`）由解析结果决定，`siteUrl` 从 Feed 里带出。

成功 `201`：

```json
{
  "source": { "id": 6, "name": "示例日报", "type": "rss", "url": "https://example.com/feed.xml",
    "siteUrl": "https://example.com/", "enabled": true, "pollIntervalMinutes": 60, "extractContent": false,
    "lastFetchedAt": "2026-10-28T04:20:00.000Z", "lastStatus": "ok", "lastError": null, "articleCount": 12 },
  "firstFetch": { "inserted": 12, "duplicates": 0, "skipped": 0, "entryCount": 12 }
}
```

失败：地址已存在 `409 E_SOURCE_EXISTS`；返回网页/坏 XML `400 E_FEED_INVALID`；地址被 SSRF 守卫拒绝 `400 E_URL_*`。
失败时不会留下半条来源。

## `PATCH /api/sources/:id`

只改配置，不触发采集。请求体至少一个字段：

```json
{ "name": "改名", "enabled": false, "pollIntervalMinutes": 120, "extractContent": true }
```

返回更新后的 `SourceSummary`。来源不存在返回 404。`extractContent` 只影响之后采集到的新文章，
不会回填已有文章。

## `DELETE /api/sources/:id`

```json
{ "deleted": true, "keptArticles": 4 }
```

只删订阅配置。文章通过 `ON DELETE SET NULL` 留在文章库和往期报纸里，`keptArticles` 是删前该来源的文章数。

## `POST /api/sources/:id/validate`

只读探测：抓取、解析、返回摘要，不写文章也不改采集状态。

```json
{ "ok": true, "feedTitle": "示例日报", "format": "rss", "siteUrl": "https://example.com/", "entryCount": 12 }
```

## `POST /api/sources/:id/fetch`

立即采集一个来源。带 `If-None-Match` / `If-Modified-Since`，命中 304 时 `status` 为 `not_modified`：

```json
{
  "source": { /* SourceSummary，lastFetchedAt/lastStatus 已更新 */ },
  "fetch": {
    "sourceId": 6, "name": "示例日报", "ok": true, "status": "ok",
    "inserted": 2, "duplicates": 10, "skipped": 0, "entryCount": 12,
    "feedTitle": "示例日报", "error": null, "errorCode": null, "extracted": 1
  }
}
```

`extracted` 是本次采集后自动提取成功的篇数：来源开启 `extractContent` 时，在本次新入库的文章里
按 id 顺序最多尝试 3 篇；单篇失败只写 `extract_error`，不影响 `ok`。

失败返回 `502`，`details` 里保留底层原因，来源行同时写入 `last_error`，**已有文章一条不动**：

```json
{ "error": { "code": "E_FETCH_FAILED", "message": "来源返回 HTTP 500", "details": { "sourceId": 6, "errorCode": "E_FETCH_FAILED" } } }
```

## `POST /api/jobs/fetch-all`

采集所有**启用**的来源，最多 3 个并发。单个来源失败不影响其它来源：

```json
{
  "results": [ /* 每个来源一条，结构同上面的 fetch，另带 attempts */ ],
  "totals": { "sources": 4, "ok": 3, "failed": 1, "inserted": 5, "duplicates": 20 }
}
```

失败来源的 `ok=false`，`error` / `errorCode` 给出原因；文章不会因为失败被删除。
`attempts` 是本次实际请求次数：这里（手动批量采集）不重试，恒为 1；每日定时任务会重试一次失败的来源。

## `GET /api/settings`

```json
{
  "schedule": {
    "enabled": true,
    "collectTime": "07:00",
    "timeZone": "Asia/Shanghai",
    "autoGenerate": true,
    "publish": false
  },
  "serverTimeZone": "Asia/Shanghai"
}
```

`serverTimeZone` 来自 `.env` 的 `TZ`，只是新库的默认值；实际生效的是 `schedule.timeZone`
（决定定时采集时刻、手动预览/生成的“今天”和时间窗零点）。设置存在 `app_settings` 表，重启后仍在。

## `PATCH /api/settings`

部分更新，至少一个字段；`schedule` 里可只给要改的键：

```json
{ "schedule": { "collectTime": "06:30", "publish": true } }
```

| 字段 | 约束 |
| --- | --- |
| `enabled` | 布尔。关掉只停自动运行，手动触发仍可用 |
| `collectTime` | `HH:MM`（24 小时制），按 `timeZone` 的当地时间 |
| `timeZone` | IANA 名称，如 `Asia/Shanghai`；无法被 `Intl` 识别的值 400 |
| `autoGenerate` | 布尔。关掉只采集，不生成期刊 |
| `publish` | 布尔。开启后定时任务直接出版；默认 `false` |

返回与 `GET /api/settings` 相同。`schedule` 为空对象或没有可识别字段时 400 `E_VALIDATION`。
保存后会立即让调度器重算下一次运行时间，不用等下一个 tick。

## `GET /api/jobs/status`

```json
{
  "schedule": { /* ScheduleSettings */ },
  "status": {
    "running": true,
    "nextRunAt": "2026-10-29T23:00:00.000Z",
    "localDate": "2026-10-28",
    "localTime": "15:42",
    "todayRun": { /* JobRunSummary | null，今天最近一次运行（含手动） */ },
    "lastRun": { /* JobRunSummary | null，全局最近一次 */ },
    "recentRuns": [ /* 最近 10 次 JobRunSummary */ ]
  }
}
```

- `running` 表示应用内调度器是否已启动（进程开着且没有调用 `stop`），不是“当前有任务在跑”。
- `nextRunAt` 是 UTC ISO 时间；定时任务停用时为 `null`，当天已完成后指向明天。
- `localDate` / `localTime` 是 `schedule.timeZone` 下的当前日期与时刻，前端不用自己算。

`JobRunSummary`：

```json
{
  "id": 12,
  "trigger": "schedule",
  "runDate": "2026-10-28",
  "status": "partial",
  "startedAt": "2026-10-28T23:00:01.000Z",
  "finishedAt": "2026-10-28T23:00:05.000Z",
  "detail": {
    "sources": {
      "total": 4, "ok": 3, "failed": 1, "inserted": 5, "duplicates": 20,
      "results": [ /* JobSourceResult，即带 attempts 的 SourceFetchResult */ ]
    },
    "issue": {
      "generated": false,
      "issueId": 7,
      "issueStatus": "draft",
      "total": 0,
      "reason": "draft_exists",
      "message": "2026-10-28 已有预览稿，定时任务不会覆盖；需要手动确认后替换"
    },
    "note": "来源 4 个：成功 3，失败 1，新增 5 篇；2026-10-28 已有预览稿…"
  }
}
```

- `trigger`：`schedule`（定时）或 `manual`（手动触发）。
- `status`：`ok`（全部成功）、`partial`（有来源失败，或因草稿/已出版而跳过生成）、`failed`（整轮失败）、
  `running`（执行中）。`skipped` 是保留值，目前不会产生。
- `issue.reason`：`null`（生成成功）、`no_recent` / `all_used` / `filters`（候选为空，不生成空刊）、
  `draft_exists`（当天已有草稿，定时任务不覆盖）、`issue_exists`（当天已出版）、`error`（生成时抛错）。
- `sources` / `issue` 在执行中或整轮失败时可能为 `null`。

## `GET /api/jobs/runs`

查询参数 `limit`：1–100，默认 20。按 `startedAt` 倒序：

```json
{ "items": [ /* JobRunSummary */ ] }
```

## `POST /api/jobs/run`

手动触发一轮与定时任务相同的流程（采集所有启用来源 → 按设置决定是否生成）。请求体可全部省略：

```json
{ "date": "2026-10-28", "generate": true, "publish": false, "replaceDraft": false }
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `date` | 设置时区的今天 | 任务归属日期；补跑过去某天时传入 |
| `generate` | `schedule.autoGenerate` | 是否在采集后生成期刊 |
| `publish` | `schedule.publish` | 生成后是否直接出版 |
| `replaceDraft` | `false` | 当天已有草稿时是否覆盖；默认不覆盖 |

返回本次的 `JobRunSummary`（HTTP 200，即使结果是 `partial` / `failed`，看 `status` 和 `detail`）。
手动触发不按日期去重，可以一天跑多次；它和定时任务共用同一把进程内锁，已有任务在跑时返回
409 `E_JOB_RUNNING`，不会排队。

失败来源会重试一次（默认间隔 1.5 秒），`detail.sources.results[].attempts` 记录实际请求次数。

## `GET /api/backups`

列出备份目录。`dir` 是绝对路径，`items` 按时间倒序：

```json
{
  "dir": "C:\\…\\data\\backups",
  "items": [
    { "file": "newspaper-backup-2026-10-28T03-40-33-819Z.db", "bytes": 163840,
      "createdAt": "2026-10-28T03:40:33.819Z", "kind": "manual" },
    { "file": "newspaper-pre-migration-2026-10-20T01-00-00-000Z.db", "bytes": 151552,
      "createdAt": "2026-10-20T01:00:00.000Z", "kind": "pre-migration" }
  ]
}
```

只列出符合 `newspaper-backup-*` / `newspaper-pre-migration-*` 命名且以 `.db` 结尾的文件。

## `POST /api/backups`

立即做一次在线备份（`db.backup()`，不用停服务），成功 `201`：

```json
{ "file": "newspaper-backup-2026-10-28T03-40-33-819Z.db", "bytes": 163840,
  "createdAt": "2026-10-28T03:40:33.819Z", "kind": "manual" }
```

恢复没有接口：停服务 → 把备份文件复制成 `data/newspaper.db` → 删除同目录的
`newspaper.db-wal` / `newspaper.db-shm` → 启动。

## `POST /api/articles/manual-link`

手动收藏一个链接。默认只存标题、摘要和链接；之后可以在文章页提取公开正文或粘贴自己的正文。

```json
{ "url": "https://example.com/post?utm_source=x", "title": "一篇文章", "summary": "可选，≤1200 字", "sourceId": 6 }
```

- `url` 会先规范化（去跟踪参数、去锚点、参数排序），重复的 URL 返回 `409 E_ARTICLE_EXISTS`（`details.articleId`）。
- `sourceId` 可选，指向已有来源；不存在时返回 `400 E_SOURCE_NOT_FOUND`。
- 有摘要时 `content_access_level=metadata`，没有时 `link_only`。

成功 `201`，返回完整 `ArticleDetail`（同 `GET /api/articles/:id`）。

---

## 本地访问的两道门

服务默认只监听 `127.0.0.1`，此时：

1. **Host 校验**：`Host` 头必须是 `localhost` / `127.0.0.1` / `[::1]` / `0.0.0.0`（可带端口），否则 403。
   这是为了挡住 DNS 重绑定——恶意网页把自己的域名解析到 127.0.0.1 也不能调用本机接口。
2. **Origin 校验**：`POST` / `PUT` / `PATCH` / `DELETE` 如果带 `Origin`，必须在
   `http://localhost:5173`、`http://127.0.0.1:5173` 或后端自身端口内，否则 403。

只要把 `HOST` 改成非回环地址，Host 校验自动关闭——**对外开放前务必先补认证与 HTTPS**，
目前没有任何账号体系，不要直接暴露到公网。
