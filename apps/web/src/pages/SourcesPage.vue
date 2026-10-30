<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SourceSummary } from '@paper/shared';
import { api, ApiError } from '../api/client';
import { useAsync } from '../composables/useAsync';
import { formatDateTime } from '../utils/format';
import StateBlock from '../components/StateBlock.vue';

const { data, loading, error, load } = useAsync(() => api.sources());
onMounted(load);

const typeLabel: Record<string, string> = {
  rss: 'RSS',
  atom: 'Atom',
  webpage: '网页',
  manual: '手动',
};

function statusOf(source: SourceSummary): { label: string; variant: 'ok' | 'error' | 'idle' } {
  if (!source.enabled) return { label: '已停用', variant: 'idle' };
  if (source.lastStatus === 'error') return { label: '采集失败', variant: 'error' };
  if (source.lastStatus === 'ok') return { label: '正常', variant: 'ok' };
  return { label: '尚未采集', variant: 'idle' };
}

const enabledCount = computed(() => data.value?.items.filter((item) => item.enabled).length ?? 0);

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

// ── 添加订阅 ──────────────────────────────────────────────
const addUrl = ref('');
const adding = ref(false);
const addError = ref('');
const addNotice = ref('');

async function addSource() {
  if (!addUrl.value.trim() || adding.value) return;
  adding.value = true;
  addError.value = '';
  addNotice.value = '';
  try {
    const result = await api.createSource({ url: addUrl.value.trim() });
    const { inserted, duplicates } = result.firstFetch;
    addNotice.value = `已添加「${result.source.name}」，收录 ${inserted} 篇${
      duplicates > 0 ? `，跳过重复 ${duplicates} 篇` : ''
    }。`;
    addUrl.value = '';
    await load();
  } catch (cause) {
    addError.value = errorMessage(cause, '添加失败，请稍后重试');
  } finally {
    adding.value = false;
  }
}

// ── 手动收录链接 ──────────────────────────────────────────
const manualUrl = ref('');
const manualTitle = ref('');
const manualSummary = ref('');
const manualPending = ref(false);
const manualError = ref('');
const manualNotice = ref('');

async function addManual() {
  if (manualPending.value) return;
  if (!manualUrl.value.trim() || !manualTitle.value.trim()) {
    manualError.value = '链接和标题都需要填写';
    return;
  }
  manualPending.value = true;
  manualError.value = '';
  manualNotice.value = '';
  try {
    const article = await api.addManualLink({
      url: manualUrl.value.trim(),
      title: manualTitle.value.trim(),
      summary: manualSummary.value.trim() || undefined,
    });
    manualNotice.value = `已收录《${article.title}》，可以在文章库里找到它。`;
    manualUrl.value = '';
    manualTitle.value = '';
    manualSummary.value = '';
  } catch (cause) {
    manualError.value = errorMessage(cause, '收录失败，请稍后重试');
  } finally {
    manualPending.value = false;
  }
}

// ── 来源操作 ──────────────────────────────────────────────
const jobNotice = ref('');
const jobError = ref('');
const pendingKey = ref('');

function pendingFor(id: number, action: string): boolean {
  return pendingKey.value === `${id}:${action}`;
}

function rowLocked(id: number): boolean {
  return pendingKey.value.startsWith(`${id}:`);
}

async function runRowAction(
  id: number,
  action: 'validate' | 'fetch' | 'toggle' | 'extract' | 'delete',
  task: () => Promise<void>,
) {
  if (pendingKey.value) return;
  pendingKey.value = `${id}:${action}`;
  jobNotice.value = '';
  jobError.value = '';
  try {
    await task();
  } catch (cause) {
    jobError.value = errorMessage(cause, '操作失败，请稍后重试');
  } finally {
    pendingKey.value = '';
  }
}

function validateSource(source: SourceSummary) {
  return runRowAction(source.id, 'validate', async () => {
    const probe = await api.validateSource(source.id);
    const format = typeLabel[probe.format] ?? probe.format;
    jobNotice.value = `「${probe.feedTitle ?? source.name}」验证通过：${format}，读到 ${probe.entryCount} 条。`;
  });
}

function fetchSource(source: SourceSummary) {
  return runRowAction(source.id, 'fetch', async () => {
    const result = await api.fetchSource(source.id);
    jobNotice.value =
      result.fetch.status === 'not_modified'
        ? `「${result.source.name}」没有更新。`
        : `「${result.source.name}」新增 ${result.fetch.inserted} 篇，跳过重复 ${result.fetch.duplicates} 篇。`;
    await load();
  });
}

function toggleSource(source: SourceSummary) {
  return runRowAction(source.id, 'toggle', async () => {
    const updated = await api.updateSource(source.id, { enabled: !source.enabled });
    jobNotice.value = `「${updated.name}」已${updated.enabled ? '启用' : '停用'}。`;
    await load();
  });
}

function toggleExtract(source: SourceSummary) {
  return runRowAction(source.id, 'extract', async () => {
    const updated = await api.updateSource(source.id, { extractContent: !source.extractContent });
    jobNotice.value = `「${updated.name}」已${updated.extractContent ? '开启' : '关闭'}自动正文提取。`;
    await load();
  });
}

const confirmId = ref<number | null>(null);
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

function askDelete(id: number) {
  confirmId.value = id;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    confirmId.value = null;
  }, 5000);
}

function cancelDelete() {
  confirmId.value = null;
  clearTimeout(confirmTimer);
}

function confirmDelete(source: SourceSummary) {
  confirmId.value = null;
  clearTimeout(confirmTimer);
  return runRowAction(source.id, 'delete', async () => {
    const result = await api.deleteSource(source.id);
    jobNotice.value = `已删除「${source.name}」，保留了 ${result.keptArticles} 篇文章。`;
    await load();
  });
}

onBeforeUnmount(() => clearTimeout(confirmTimer));

// ── 全部采集 ──────────────────────────────────────────────
const fetchingAll = ref(false);

async function fetchAll() {
  if (fetchingAll.value) return;
  fetchingAll.value = true;
  jobNotice.value = '';
  jobError.value = '';
  try {
    const result = await api.fetchAllSources();
    const { totals } = result;
    jobNotice.value = `${totals.sources} 个来源：成功 ${totals.ok}，失败 ${totals.failed}，新增 ${totals.inserted} 篇，跳过重复 ${totals.duplicates} 篇。`;
    const failed = result.results.filter((item) => !item.ok);
    if (failed.length > 0) {
      jobError.value = failed.map((item) => `${item.name}：${item.error ?? '采集失败'}`).join('；');
    }
    await load();
  } catch (cause) {
    jobError.value = errorMessage(cause, '批量采集失败，请稍后重试');
  } finally {
    fetchingAll.value = false;
  }
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <p class="page-head__kicker">SOURCES · 收录入口</p>
      <h1 class="page-head__title">信息来源</h1>
      <p class="page-head__hint">
        每个来源独立采集，单个来源失败不会影响其它来源，也不会清空已经收录的文章。添加前会先抓一次确认能读。
      </p>
    </header>

    <section class="intake" aria-label="添加来源">
      <form class="intake__card" @submit.prevent="addSource">
        <h2 class="intake__title">添加订阅</h2>
        <p class="intake__hint">填入 RSS / Atom 地址。抓取成功才会保存，重复文章按链接和内容判重。</p>
        <label class="field">
          <span class="field__label">Feed 地址</span>
          <input
            v-model="addUrl"
            class="field__input"
            type="url"
            inputmode="url"
            placeholder="https://example.com/feed.xml"
            :disabled="adding"
            required
          />
        </label>
        <div class="btn-row">
          <button class="btn btn--primary" type="submit" :disabled="adding || !addUrl.trim()">
            {{ adding ? '正在抓取…' : '添加并采集' }}
          </button>
          <span v-if="addError" class="error-text" role="alert">{{ addError }}</span>
          <span v-else-if="addNotice" class="ok-text" role="status">{{ addNotice }}</span>
        </div>
        <ul class="intake__notes">
          <li>支持 RSS 2.0、RSS 1.0 与 Atom。</li>
          <li>每次最多读取 300 条；单次请求 15 秒超时、2 MB 上限。</li>
          <li>默认只记录标题、摘要和链接；正文提取默认关闭，可以在文章页单篇提取。</li>
          <li>不绕过登录、验证码或付费墙；提取失败会保留链接和摘要。</li>
        </ul>
      </form>

      <form class="intake__card" @submit.prevent="addManual">
        <h2 class="intake__title">手动收录</h2>
        <p class="intake__hint">先收下链接、标题和摘要；之后可以粘贴你有权使用的正文，或从公开页面提取。</p>
        <label class="field">
          <span class="field__label">原文链接</span>
          <input
            v-model="manualUrl"
            class="field__input"
            type="url"
            inputmode="url"
            placeholder="https://example.com/article"
            :disabled="manualPending"
            required
          />
        </label>
        <label class="field">
          <span class="field__label">标题</span>
          <input
            v-model="manualTitle"
            class="field__input"
            type="text"
            maxlength="300"
            placeholder="这篇文章讲什么"
            :disabled="manualPending"
            required
          />
        </label>
        <label class="field">
          <span class="field__label">摘要（可选）</span>
          <textarea
            v-model="manualSummary"
            class="field__input"
            rows="2"
            maxlength="1200"
            placeholder="一两句话，之后排版时会用到"
            :disabled="manualPending"
          ></textarea>
        </label>
        <div class="btn-row">
          <button class="btn" type="submit" :disabled="manualPending || !manualUrl.trim() || !manualTitle.trim()">
            {{ manualPending ? '正在收录…' : '收录进文章库' }}
          </button>
          <span v-if="manualError" class="error-text" role="alert">{{ manualError }}</span>
          <span v-else-if="manualNotice" class="ok-text" role="status">{{ manualNotice }}</span>
        </div>
      </form>
    </section>

    <div v-if="jobNotice" class="notice notice--wide" role="status">{{ jobNotice }}</div>
    <div v-if="jobError" class="notice notice--wide notice--error" role="alert">{{ jobError }}</div>

    <div v-if="data && data.items.length > 0" class="source-toolbar">
      <p class="masthead__quiet">
        共 {{ data.items.length }} 个来源，{{ enabledCount }} 个启用中
      </p>
      <button
        class="btn"
        type="button"
        :disabled="fetchingAll || enabledCount === 0"
        @click="fetchAll"
      >
        {{ fetchingAll ? '正在采集…' : '全部采集' }}
      </button>
    </div>

    <StateBlock v-if="loading" variant="loading" />

    <StateBlock
      v-else-if="error"
      variant="error"
      mark="信息来源"
      title="来源列表没能取回来"
      :hint="error"
      @retry="load"
    />

    <StateBlock
      v-else-if="!data || data.items.length === 0"
      variant="empty"
      mark="信息来源"
      title="还没有添加任何来源"
      hint="在上面填入一个 RSS/Atom 地址，或者粘贴一篇文章链接，就能开始编第一期。"
    />

    <template v-else>
      <div class="table-wrap">
        <table class="data-table data-table--sources">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">类型</th>
              <th scope="col">地址</th>
              <th scope="col">状态</th>
              <th scope="col">正文</th>
              <th scope="col">最近采集</th>
              <th scope="col">文章</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="source in data.items" :key="source.id">
              <td>
                {{ source.name }}
                <p v-if="source.lastError" class="error-text">{{ source.lastError }}</p>
              </td>
              <td>{{ typeLabel[source.type] ?? source.type }}</td>
              <td class="url">{{ source.url }}</td>
              <td>
                <span class="status" :class="`status--${statusOf(source).variant}`">
                  <span class="status__dot" aria-hidden="true"></span>
                  {{ statusOf(source).label }}
                </span>
              </td>
              <td>
                <button
                  class="btn btn--quiet"
                  type="button"
                  :aria-pressed="source.extractContent"
                  :disabled="rowLocked(source.id)"
                  @click="toggleExtract(source)"
                >
                  {{
                    pendingFor(source.id, 'extract')
                      ? '处理中…'
                      : source.extractContent
                        ? '自动提取：开'
                        : '自动提取：关'
                  }}
                </button>
              </td>
              <td>{{ source.lastFetchedAt ? formatDateTime(source.lastFetchedAt) : '—' }}</td>
              <td>{{ source.articleCount }}</td>
              <td>
                <div class="row-actions">
                  <button
                    class="btn btn--quiet"
                    type="button"
                    :disabled="rowLocked(source.id)"
                    @click="validateSource(source)"
                  >
                    {{ pendingFor(source.id, 'validate') ? '验证中…' : '验证' }}
                  </button>
                  <button
                    class="btn btn--quiet"
                    type="button"
                    :disabled="rowLocked(source.id)"
                    @click="fetchSource(source)"
                  >
                    {{ pendingFor(source.id, 'fetch') ? '采集中…' : '立即采集' }}
                  </button>
                  <button
                    class="btn btn--quiet"
                    type="button"
                    :disabled="rowLocked(source.id)"
                    @click="toggleSource(source)"
                  >
                    {{ pendingFor(source.id, 'toggle') ? '处理中…' : source.enabled ? '停用' : '启用' }}
                  </button>

                  <template v-if="confirmId === source.id">
                    <button
                      class="btn btn--quiet btn--danger"
                      type="button"
                      :disabled="rowLocked(source.id)"
                      @click="confirmDelete(source)"
                    >
                      {{ pendingFor(source.id, 'delete') ? '删除中…' : '确认删除' }}
                    </button>
                    <button
                      class="btn btn--quiet"
                      type="button"
                      :disabled="rowLocked(source.id)"
                      @click="cancelDelete"
                    >
                      取消
                    </button>
                  </template>
                  <button
                    v-else
                    class="btn btn--quiet btn--danger"
                    type="button"
                    :disabled="rowLocked(source.id)"
                    @click="askDelete(source.id)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="masthead__quiet" style="margin-top: 16px">
        删除来源只删除订阅配置，已经收录的文章会留在文章库和往期报纸里。开启「自动提取」的来源，每次采集后最多读取 3 篇新文章的公开正文；失败不影响采集，也可以随时在文章页单篇提取。
      </p>
    </template>
  </div>
</template>
