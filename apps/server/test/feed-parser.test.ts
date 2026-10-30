import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, FeedParseError } from '../src/collectors/feed-parser.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>示例日报</title>
    <link>https://example.com/blog/</link>
    <item>
      <title><![CDATA[第一篇 & 它的标题]]></title>
      <link>/posts/one?utm_source=rss</link>
      <description><![CDATA[<p>摘要 <strong>加粗</strong> &amp; 实体</p><script>alert(1)</script>]]></description>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/one.jpg" type="image/jpeg"/>
      <dc:creator>甲</dc:creator>
    </item>
    <item>
      <title>没有链接的条目</title>
      <description>会被跳过</description>
    </item>
    <item>
      <title>邮件链接</title>
      <link>mailto:someone@example.com</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 源</title>
  <link rel="alternate" href="https://atom.example.org/"/>
  <entry>
    <title>Atom 第一篇</title>
    <id>urn:uuid:1</id>
    <published>2026-10-27T08:00:00Z</published>
    <summary type="html">&lt;p&gt;原子摘要&lt;/p&gt;</summary>
    <author><name>阮一峰</name></author>
    <link rel="self" href="/entries/1.xml"/>
    <link rel="alternate" type="text/html" href="/entries/1"/>
    <media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" url="https://atom.example.org/1.png"/>
  </entry>
  <entry>
    <title>只有 self 链接</title>
    <id>urn:uuid:2</id>
    <link rel="self" href="https://atom.example.org/entries/2.xml"/>
    <updated>2026-10-28T01:02:03+08:00</updated>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.com/">
    <title>RDF 源</title>
    <link>https://rdf.example.com/</link>
  </channel>
  <item rdf:about="https://rdf.example.com/p/1">
    <title>RDF 第一篇</title>
    <link>https://rdf.example.com/p/1</link>
    <dc:date>2026-10-25T12:00:00Z</dc:date>
    <dc:creator>乙</dc:creator>
    <description>RDF 摘要</description>
  </item>
</rdf:RDF>`;

test('解析 RSS 2.0：相对链接补全、HTML 摘要转纯文本、图片与作者', () => {
  const feed = parseFeed(RSS, 'https://example.com/feed.xml');
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, '示例日报');
  assert.equal(feed.siteUrl, 'https://example.com/blog/');
  assert.equal(feed.entries.length, 1);

  const entry = feed.entries[0]!;
  assert.equal(entry.title, '第一篇 & 它的标题');
  assert.equal(entry.link, 'https://example.com/posts/one?utm_source=rss');
  assert.equal(entry.summary, '摘要 加粗 & 实体');
  assert.equal(entry.imageUrl, 'https://cdn.example.com/one.jpg');
  assert.equal(entry.author, '甲');
  assert.equal(entry.externalId, 'post-1');
  assert.equal(entry.publishedAt, '2026-10-26T08:00:00.000Z');
});

test('解析 Atom：alternate 链接优先，self 链接兜底，相对地址按 Feed 地址补全', () => {
  const feed = parseFeed(ATOM, 'https://atom.example.org/feed.xml');
  assert.equal(feed.format, 'atom');
  assert.equal(feed.title, 'Atom 源');
  assert.equal(feed.siteUrl, 'https://atom.example.org/');
  assert.equal(feed.entries.length, 2);

  const first = feed.entries[0]!;
  assert.equal(first.link, 'https://atom.example.org/entries/1');
  assert.equal(first.summary, '原子摘要');
  assert.equal(first.author, '阮一峰');
  assert.equal(first.imageUrl, 'https://atom.example.org/1.png');
  assert.equal(first.externalId, 'urn:uuid:1');

  const second = feed.entries[1]!;
  assert.equal(second.link, 'https://atom.example.org/entries/2.xml');
  assert.equal(second.publishedAt, '2026-10-27T17:02:03.000Z');
  assert.equal(second.summary, null);
});

test('解析 RSS 1.0 (RDF)：条目在根节点，dc:date 可用', () => {
  const feed = parseFeed(RDF, 'https://rdf.example.com/feed.rdf');
  assert.equal(feed.format, 'rss');
  assert.equal(feed.title, 'RDF 源');
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0]!.publishedAt, '2026-10-25T12:00:00.000Z');
  assert.equal(feed.entries[0]!.author, '乙');
});

test('把网页当成 Feed 时给出可读错误', () => {
  assert.throws(
    () => parseFeed('<!doctype html><html><body>hi</body></html>', 'https://example.com/'),
    (error: unknown) => error instanceof FeedParseError && /网页而不是 Feed/.test(error.message),
  );
});

test('XML 不合法时抛 FeedParseError 而不是崩溃', () => {
  assert.throws(
    () => parseFeed('<rss><channel><title>没闭合</title></channel>', 'https://example.com/feed.xml'),
    (error: unknown) => error instanceof FeedParseError,
  );
});

test('空响应与无法识别的格式都会被拒绝', () => {
  assert.throws(() => parseFeed('   ', 'https://example.com/feed.xml'), FeedParseError);
  assert.throws(
    () => parseFeed('<root><a>1</a></root>', 'https://example.com/feed.xml'),
    (error: unknown) => error instanceof FeedParseError && /无法识别/.test(error.message),
  );
});

test('实体只解码到文本层，不会因为二次解码变成标签', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
    <item><title>5 &amp;lt; 6 &#20013;</title><link>https://example.com/a</link></item>
  </channel></rss>`;
  const feed = parseFeed(xml, 'https://example.com/feed.xml');
  assert.equal(feed.entries[0]!.title, '5 < 6 中');
});
