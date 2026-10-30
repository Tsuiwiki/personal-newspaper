<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import snapshot from 'virtual:published-paper';
import SectionBlock from './components/SectionBlock.vue';
import SafeImage from './components/SafeImage.vue';
import { applyTheme } from './utils/theme';
import { formatDateTime, formatIssueDate, paragraphList } from './utils/format';

const route = useRoute();
const fontSize = ref(18);
const latest = snapshot.issues[0];
const article = computed(() => route.name === 'article'
  ? snapshot.issues.flatMap(issue => issue.sections.flatMap(section => section.articles))
    .find(item => item.id === Number(route.params.id))
  : undefined);
const parentIssue = computed(() => article.value && snapshot.issues.find(issue =>
  issue.sections.some(section => section.articles.some(item => item.id === article.value?.id))));
const issue = computed(() => route.name === 'paper' ? latest
  : route.name === 'issue' ? snapshot.issues.find(item => item.id === Number(route.params.id))
  : undefined);
const displaySections = computed(() => issue.value?.sections.map(section => ({
  ...section,
  articles: section.articles.map(item => ({ ...item, sourceId: null, readingStatus: 'unread' as const })),
})) ?? []);
const total = computed(() => issue.value?.sections.reduce((sum, section) => sum + section.articles.length, 0) ?? 0);
const paragraphs = computed(() => paragraphList(article.value?.contentText ?? null));
const accessLabel = computed(() => article.value?.isSample ? '示例文章'
  : article.value?.accessLevel === 'user_provided' ? '正文由用户提供'
  : article.value?.accessLevel === 'extracted' ? '正文提取自公开页面' : '仅保存摘要或链接');
const backTo = computed(() => parentIssue.value ? `/issue/${parentIssue.value.id}` : '/');
watch(() => route.fullPath, () => {
  const theme = issue.value?.theme ?? parentIssue.value?.theme ?? latest?.theme;
  if (theme) applyTheme(theme);
  fontSize.value = theme?.bodyFontSize ?? 18;
  document.title = `${article.value?.title ?? (route.name === 'archive' ? '期刊档案' : issue.value?.masthead.title ?? '纸间')} · 只读版`;
}, { immediate: true });
</script>

<template>
  <a class="skip-link" href="#main" @click.prevent="($refs.main as HTMLElement).focus()">跳到正文</a>
  <div class="shell">
    <header class="site-header">
      <div class="site-header__inner">
        <RouterLink to="/" class="brand" aria-label="回到报纸首页">
          <span class="brand__mark">{{ latest?.masthead.title ?? '纸间' }}</span>
          <span class="brand__sub">只读版</span>
        </RouterLink>
        <nav class="nav" aria-label="主导航">
          <RouterLink to="/" class="nav__link" exact-active-class="nav__link--active">本期报纸</RouterLink>
          <RouterLink to="/archive" class="nav__link" exact-active-class="nav__link--active">期刊档案</RouterLink>
        </nav>
      </div>
    </header>
    <main id="main" ref="main" class="main" tabindex="-1">
      <div class="page">
        <template v-if="issue">
          <header class="masthead">
            <div class="masthead__dateline">
              <div class="masthead__dateline-group">
                <span>{{ formatIssueDate(issue.issueDate, issue.masthead.dateFormat) }}</span>
                <span>第 {{ issue.issueNumber }} 期</span>
                <span>已出版</span>
              </div>
              <div class="masthead__dateline-group"><span>共 {{ total }} 篇</span><span>只读存档</span></div>
            </div>
            <h1 class="masthead__title">{{ issue.masthead.title }}</h1>
            <p v-if="issue.masthead.subtitle" class="masthead__subtitle">{{ issue.masthead.subtitle }}</p>
            <div class="masthead__rule" aria-hidden="true"></div>
          </header>
          <div class="issue">
            <SectionBlock v-for="(section, index) in displaySections" :key="section.name" :section="section" :index="index" />
          </div>
          <p class="issue-end">本期到此 · 共 {{ total }} 篇</p>
        </template>
        <template v-else-if="route.name === 'archive'">
          <header class="page-head">
            <p class="page-head__kicker">ARCHIVE · 按期回看</p>
            <h1 class="page-head__title">期刊档案</h1>
            <p class="page-head__hint">只收录已出版的报纸，保留当期的栏目、顺序与版面样式。</p>
          </header>
          <div class="archive">
            <RouterLink v-for="item in snapshot.issues" :key="item.id" :to="`/issue/${item.id}`" class="archive__row">
              <span class="archive__date">{{ formatIssueDate(item.issueDate, 'YYYY年M月D日') }}</span>
              <span class="archive__title">第 {{ item.issueNumber }} 期 · {{ item.masthead.title }}</span>
              <span class="archive__meta archive__meta--articles">{{ item.sections.reduce((sum, section) => sum + section.articles.length, 0) }} 篇</span>
              <span class="archive__meta">已出版</span>
            </RouterLink>
          </div>
        </template>
        <article v-else-if="article" class="reader" :style="{ '--reader-size': `${fontSize}px` }" aria-labelledby="article-title">
          <RouterLink :to="backTo" class="reader__back">← 回到本期报纸</RouterLink>
          <p class="reader__kicker"><span class="reader__kicker-source">{{ article.sourceName ?? '手动收录' }}</span><span>·</span><span>{{ accessLabel }}</span></p>
          <h1 id="article-title" class="reader__title">{{ article.title }}</h1>
          <p class="reader__byline">
            <span v-if="article.author">{{ article.author }} · </span>
            <time :datetime="article.publishedAt ?? undefined">{{ formatDateTime(article.publishedAt) }}</time>
            <span> · {{ article.hasFullText ? `约 ${article.readMinutes} 分钟` : '仅有摘要' }}</span>
          </p>
          <div class="reader__toolbar">
            <div class="fontctl" role="group" aria-label="正文字号">
              <span>字号</span>
              <button class="fontctl__btn" type="button" aria-label="减小字号" :disabled="fontSize <= 14" @click="fontSize = Math.max(14, fontSize - 1)">A−</button>
              <span class="fontctl__value">{{ fontSize }}px</span>
              <button class="fontctl__btn" type="button" aria-label="增大字号" :disabled="fontSize >= 26" @click="fontSize = Math.min(26, fontSize + 1)">A+</button>
            </div>
            <a v-if="article.originalUrl" :href="article.originalUrl" class="btn" target="_blank" rel="noopener noreferrer">前往原文 ↗</a>
          </div>
          <div v-if="article.summary" class="summary-box">
            <span class="summary-box__label">{{ article.isSample ? '摘要 · 示例内容' : '摘要 · 不等于原文全文' }}</span>
            <p class="summary-box__text">{{ article.summary }}</p>
          </div>
          <SafeImage v-if="article.imageUrl" class="reader__figure" :src="article.imageUrl" :alt="article.title" :credit="article.sourceName" variant="feature" />
          <div v-if="paragraphs.length" class="reader__body">
            <p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p>
          </div>
          <p v-else class="notice notice--wide"><strong>这一篇没有保存正文。</strong>本次存档保留标题和摘要，不补写或生成全文。</p>
          <p v-if="article.isSample" class="reader__origin">这是用于演示排版的示例文章，未提供真实原文链接。</p>
          <p v-else-if="article.accessLevel === 'extracted'" class="reader__origin">正文提取自公开页面，可能存在缺段，以原文为准。</p>
          <nav class="reader__next" aria-label="读完后"><RouterLink :to="backTo" class="btn">回到本期报纸</RouterLink></nav>
        </article>
        <header v-else class="page-head">
          <h1 class="page-head__title">这一页不在只读存档中</h1>
          <p class="page-head__hint">只读站点仅包含已出版报纸及其文章。</p>
          <RouterLink to="/" class="btn">回到报纸首页</RouterLink>
        </header>
      </div>
    </main>
    <footer class="site-footer"><div class="site-footer__inner">
      <span>只读快照 · {{ formatDateTime(snapshot.exportedAt) }}</span>
      <span>不会自动同步；采集、编辑和个人笔记留在本机</span>
    </div></footer>
  </div>
</template>
