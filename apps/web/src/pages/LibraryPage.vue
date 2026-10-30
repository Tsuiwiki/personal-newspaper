<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { ReadingStatus, SourceSummary } from '@paper/shared';
import { api } from '../api/client';
import { useAsync } from '../composables/useAsync';
import { relativeTime } from '../utils/format';
import StateBlock from '../components/StateBlock.vue';

type Filter = 'all' | ReadingStatus;
type SourceFilter = 'all' | number;

const PAGE_SIZE = 20;

const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'later', label: '稍后读' },
  { value: 'read', label: '已读' },
];

const filter = ref<Filter>('all');
const sourceId = ref<SourceFilter>('all');
const q = ref('');
const searchInput = ref('');
const page = ref(1);
const sources = ref<SourceSummary[]>([]);

const { data, loading, error, load } = useAsync(() =>
  api.articles({
    status: filter.value === 'all' ? undefined : filter.value,
    sourceId: sourceId.value === 'all' ? undefined : sourceId.value,
    q: q.value || undefined,
    page: page.value,
    pageSize: PAGE_SIZE,
  }),
);

const pageCount = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / PAGE_SIZE)));
const hasFilters = computed(() => filter.value !== 'all' || sourceId.value !== 'all' || q.value !== '');
const canPrev = computed(() => page.value > 1 && !loading.value);
const canNext = computed(() => page.value < pageCount.value && !loading.value);

watch([filter, sourceId, q], () => {
  page.value = 1;
});
watch([filter, sourceId, q, page], () => load(), { immediate: true });

onMounted(async () => {
  try {
    sources.value = (await api.sources()).items;
  } catch {
    sources.value = [];
  }
});

function applySearch(): void {
  q.value = searchInput.value.trim();
}

function clearSearch(): void {
  searchInput.value = '';
  q.value = '';
}

function clearAllFilters(): void {
  clearSearch();
  filter.value = 'all';
  sourceId.value = 'all';
}

function goPage(delta: number): void {
  page.value = Math.min(Math.max(1, page.value + delta), pageCount.value);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function statusLabel(status: ReadingStatus): string {
  if (status === 'read') return '已读';
  if (status === 'later') return '稍后读';
  return '未读';
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <p class="page-head__kicker">LIBRARY · 全部收录</p>
      <h1 class="page-head__title">文章库</h1>
      <p class="page-head__hint">
        这里放的是所有收录过的文章，包括没编进报纸的那部分。一期装不下的内容留在这里，等下一期。
      </p>
    </header>

    <div class="filters" role="group" aria-label="按阅读状态筛选">
      <button
        v-for="item in filters"
        :key="item.value"
        type="button"
        class="chip"
        :aria-pressed="filter === item.value"
        @click="filter = item.value"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="library-tools">
      <form class="library-search" role="search" @submit.prevent="applySearch">
        <label class="library-tools__label" for="library-q">搜索标题或摘要</label>
        <div class="library-search__row">
          <input
            id="library-q"
            v-model="searchInput"
            class="field__input library-search__input"
            type="search"
            maxlength="200"
            placeholder="输入关键词"
          />
          <button type="submit" class="btn btn--quiet">搜索</button>
          <button v-if="q" type="button" class="library-clear" @click="clearSearch">清除</button>
        </div>
      </form>

      <label class="library-source">
        <span class="library-tools__label">来源</span>
        <select v-model="sourceId" class="field__input library-source__select">
          <option value="all">全部来源</option>
          <option v-for="source in sources" :key="source.id" :value="source.id">
            {{ source.name }}{{ source.enabled ? '' : '（已停用）' }}
          </option>
        </select>
      </label>
    </div>

    <StateBlock v-if="loading" variant="loading" />

    <StateBlock
      v-else-if="error"
      variant="error"
      mark="文章库"
      title="文章库没能取回来"
      :hint="error"
      @retry="load"
    />

    <StateBlock
      v-else-if="!data || data.items.length === 0"
      variant="empty"
      mark="文章库"
      :title="hasFilters ? '没有符合条件的文章' : '文章库还是空的'"
      :hint="
        hasFilters
          ? '换个关键词、来源或阅读状态试试；筛选条件不会改动文章本身。'
          : '去信息来源添加订阅，或者在来源页手动收录一个链接。'
      "
    >
      <template #actions>
        <button v-if="hasFilters" type="button" class="btn" @click="clearAllFilters">清除筛选</button>
        <RouterLink to="/sources" class="btn btn--quiet">查看信息来源</RouterLink>
      </template>
    </StateBlock>

    <template v-else>
      <p class="library-summary">
        共 {{ data.total }} 篇 · 第 {{ page }} / {{ pageCount }} 页 · 每页 {{ PAGE_SIZE }} 篇
      </p>

      <div class="library">
        <RouterLink
          v-for="article in data.items"
          :key="article.id"
          :to="`/article/${article.id}`"
          class="library__row"
        >
          <span class="library__title">{{ article.title }}</span>
          <span class="library__source">{{ article.sourceName ?? '手动添加' }}</span>
          <span class="library__meta">
            {{ statusLabel(article.readingStatus) }} · {{ relativeTime(article.publishedAt) }}
          </span>
        </RouterLink>
      </div>

      <nav v-if="pageCount > 1" class="pager" aria-label="文章库分页">
        <button type="button" class="btn btn--quiet" :disabled="!canPrev" @click="goPage(-1)">
          上一页
        </button>
        <span class="pager__status">第 {{ page }} / {{ pageCount }} 页</span>
        <button type="button" class="btn btn--quiet" :disabled="!canNext" @click="goPage(1)">
          下一页
        </button>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.library-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px 24px;
  margin-bottom: 20px;
}

.library-search {
  flex: 1 1 320px;
  max-width: 460px;
}

.library-search__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.library-tools__label {
  display: block;
  font-family: var(--sans);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--ink-faint);
  margin-bottom: 6px;
}

.library-search__input {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--paper-raise);
}

.library-clear {
  border: 0;
  background: transparent;
  padding: 4px 2px;
  font-family: var(--sans);
  font-size: 12px;
  color: var(--ink-muted);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
  white-space: nowrap;
}

.library-clear:hover {
  color: var(--ink);
}

.library-source {
  display: block;
  flex: 0 0 auto;
}

.library-source__select {
  width: auto;
  min-width: 12em;
  background: var(--paper-raise);
}

.library-summary {
  margin: 0 0 10px;
  font-family: var(--sans);
  font-size: 11.5px;
  letter-spacing: 0.05em;
  color: var(--ink-faint);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 24px;
}

.pager__status {
  font-family: var(--sans);
  font-size: 12px;
  color: var(--ink-muted);
}

@media (max-width: 720px) {
  .library-tools {
    align-items: stretch;
  }

  .library-search {
    flex: 1 1 100%;
    max-width: none;
  }

  .library-source {
    flex: 1 1 100%;
  }

  .library-source__select {
    width: 100%;
  }

  .library-search__row {
    flex-wrap: wrap;
  }

  .library-search__input {
    flex: 1 1 100%;
  }
}
</style>
