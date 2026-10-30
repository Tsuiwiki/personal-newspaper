<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { IssuePreview } from '@paper/shared';
import { api, ApiError } from '../api/client';
import { useAsync } from '../composables/useAsync';
import { applyTheme, resetTheme } from '../utils/theme';
import PaperMasthead from '../components/PaperMasthead.vue';
import SectionBlock from '../components/SectionBlock.vue';
import StateBlock from '../components/StateBlock.vue';

const { data: issue, loading, error, load } = useAsync(() => api.latestIssue());

const preview = ref<IssuePreview | null>(null);
const previewing = ref(false);
const saving = ref(false);
const publishing = ref(false);
const flowError = ref('');
const flowNotice = ref('');

const layoutLabels: Record<string, string> = {
  headline: '头条',
  feature: '大图 · 深读',
  double: '双栏',
  list: '列表',
  brief: '简讯',
};

const reasons: Record<string, string> = {
  no_recent: '最近 7 天里没有采集到新文章。可以先去信息来源采集，或检查来源是否还启用着。',
  all_used: '最近 7 天符合条件的文章都已经编进过往期刊了；不会把旧内容重新包装成今天的新刊。',
  filters: '文章库里有内容，但都被栏目的来源或时间筛选排除了。去模板编辑器检查栏目筛选。',
};

const emptySectionNames = computed(() =>
  (preview.value?.sections ?? [])
    .filter((section) => section.articles.length === 0)
    .map((section) => section.name),
);

function describe(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : '操作失败，请稍后重试。';
}

async function openPreview(): Promise<void> {
  previewing.value = true;
  flowError.value = '';
  flowNotice.value = '';
  try {
    preview.value = await api.previewIssue({});
  } catch (cause) {
    flowError.value = describe(cause);
  } finally {
    previewing.value = false;
  }
}

function closePreview(): void {
  if (saving.value) return;
  preview.value = null;
}

async function saveIssue(publish: boolean): Promise<void> {
  if (!preview.value) return;
  saving.value = true;
  flowError.value = '';
  try {
    const result = await api.generateIssue({
      publish,
      replaceDraft: Boolean(preview.value.existingIssue),
    });
    if (!result.generated) {
      preview.value = result.preview;
      flowError.value = reasons[result.reason ?? 'no_recent'] ?? '没有可编的内容，没有生成空刊。';
      return;
    }
    preview.value = null;
    flowNotice.value = publish
      ? '这一期已经出版，首页和档案都会按这份版面显示。'
      : '已保存为预览稿。确认版面后，可以在报头下方发布。';
    await load();
  } catch (cause) {
    flowError.value = describe(cause);
  } finally {
    saving.value = false;
  }
}

async function publishCurrent(): Promise<void> {
  if (!issue.value) return;
  publishing.value = true;
  flowError.value = '';
  try {
    await api.publishIssue(issue.value.id);
    flowNotice.value = '这一期已出版。';
    await load();
  } catch (cause) {
    flowError.value = describe(cause);
  } finally {
    publishing.value = false;
  }
}

watch(
  issue,
  (value) => {
    if (value) applyTheme(value.theme);
  },
  { immediate: true },
);

onMounted(load);
onUnmounted(resetTheme);
</script>

<template>
  <div class="page">
    <p v-if="flowNotice" class="ok-text flow-message" role="status">{{ flowNotice }}</p>
    <p v-if="flowError" class="notice notice--error flow-message" role="alert">{{ flowError }}</p>

    <section v-if="preview" class="proof" aria-labelledby="proof-title">
      <header class="proof__head">
        <div>
          <p class="proof__kicker">GENERATION PREVIEW · 尚未写入</p>
          <h2 id="proof-title" class="proof__title">编排预览 · {{ preview.issueDate }}</h2>
          <p class="proof__template">{{ preview.templateName }}</p>
        </div>
        <button type="button" class="btn btn--quiet" :disabled="saving" @click="closePreview">
          收起
        </button>
      </header>

      <dl class="proof__facts">
        <div>
          <dt>选中 / 容量</dt>
          <dd>{{ preview.total }} / {{ preview.maxTotalArticles }} 篇</dd>
        </div>
        <div>
          <dt>可编候选</dt>
          <dd>{{ preview.candidates.eligible }} 篇</dd>
        </div>
        <div>
          <dt>已用过</dt>
          <dd>{{ preview.candidates.used }} 篇</dd>
        </div>
      </dl>

      <p v-if="preview.existingIssue" class="notice proof__notice">
        <template v-if="preview.existingIssue.status === 'published'">
          <strong>今天已经出版第 {{ preview.existingIssue.issueNumber }} 期。</strong>
          已出版的版面不会被覆盖，同一天也不能再生成新的一期。
        </template>
        <template v-else>
          <strong>今天已有一份预览稿（第 {{ preview.existingIssue.issueNumber }} 期）。</strong>
          保存会用当前模板重新编排并替换它，原草稿的版面不会留存。
        </template>
      </p>

      <div v-if="preview.total === 0" class="proof__empty">
        <strong>没有可编的内容，不会生成空刊。</strong>
        <p>{{ reasons[preview.emptyReason ?? 'no_recent'] }}</p>
        <p class="proof__hint">
          选稿规则：只取启用来源（以及手动添加）的、时间窗口内、还没编进过任何一期期刊的文章。
        </p>
      </div>

      <template v-else>
        <ol class="proof__sections">
          <li
            v-for="section in preview.sections.filter((item) => item.articles.length > 0)"
            :key="section.sectionId ?? section.name"
            class="proof__section"
          >
            <div class="proof__section-head">
              <strong>{{ section.name }}</strong>
              <span>{{ layoutLabels[section.layoutType] ?? section.layoutType }}</span>
              <span class="proof__section-count">
                {{ section.articles.length }} 篇
                <template v-if="section.omitted > 0"> · {{ section.omitted }} 篇留在文章库</template>
              </span>
            </div>
            <ul class="proof__articles">
              <li v-for="article in section.articles" :key="article.id">
                <RouterLink :to="`/article/${article.id}`" class="proof__article-link">
                  {{ article.title }}
                </RouterLink>
                <span v-if="article.sourceName" class="proof__source">{{ article.sourceName }}</span>
              </li>
            </ul>
          </li>
        </ol>
        <p v-if="emptySectionNames.length > 0" class="proof__hint">
          没有选到文章的栏目不会出现在报纸上：{{ emptySectionNames.join('、') }}。
        </p>
      </template>

      <div class="proof__actions">
        <template v-if="preview.total > 0 && preview.existingIssue?.status !== 'published'">
          <button type="button" class="btn btn--primary" :disabled="saving" @click="saveIssue(false)">
            {{ preview.existingIssue ? '替换今日预览稿' : '保存为预览稿' }}
          </button>
          <button type="button" class="btn" :disabled="saving" @click="saveIssue(true)">
            {{ preview.existingIssue ? '替换并出版' : '保存并出版' }}
          </button>
        </template>
        <button type="button" class="btn btn--quiet" :disabled="saving" @click="closePreview">
          取消
        </button>
        <span v-if="saving" class="proof__hint">正在写入数据库…</span>
      </div>
    </section>

    <StateBlock v-if="loading" variant="loading" />

    <StateBlock
      v-else-if="error"
      variant="error"
      mark="今日报纸"
      title="这一期没能取回来"
      :hint="error"
      @retry="load"
    >
      <template #actions>
        <RouterLink to="/settings" class="btn btn--quiet">检查设置</RouterLink>
      </template>
    </StateBlock>

    <StateBlock
      v-else-if="!issue"
      variant="empty"
      mark="今日报纸"
      title="还没有编好的一期"
      hint="点“生成一期”会按默认模板，从最近 7 天里还没编过的文章中选稿。没有可编内容时不会生成空刊，也不会拿旧文章冒充今天。"
    >
      <template #actions>
        <button type="button" class="btn" :disabled="previewing" @click="openPreview">
          {{ previewing ? '正在编排…' : '生成一期' }}
        </button>
        <RouterLink to="/sources" class="btn btn--quiet">去信息来源采集</RouterLink>
      </template>
    </StateBlock>

    <template v-else>
      <PaperMasthead :issue="issue" />

      <div class="issue-actions">
        <button
          v-if="issue.status === 'draft'"
          type="button"
          class="btn btn--primary"
          :disabled="publishing"
          @click="publishCurrent"
        >
          {{ publishing ? '正在发布…' : '发布这一期' }}
        </button>
        <button type="button" class="btn btn--quiet" :disabled="previewing" @click="openPreview">
          {{ previewing ? '正在编排…' : '重新生成预览' }}
        </button>
        <RouterLink to="/templates" class="btn btn--quiet">调整模板</RouterLink>
      </div>

      <p v-if="issue.status === 'draft'" class="notice draft-note">
        <strong>这是预览稿。</strong>
        它已经按版面写入数据库，但还没有标为正式出版；确认无误后点“发布这一期”。
      </p>

      <div class="issue">
        <SectionBlock
          v-for="(section, index) in issue.sections"
          :key="section.sectionId ?? section.name"
          :section="section"
          :index="index"
        />
      </div>

      <p class="issue-end">本期到此 · 共 {{ issue.stats.total }} 篇</p>
    </template>
  </div>
</template>

<style scoped>
.flow-message {
  margin: 0 0 18px;
}

.issue-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  margin: -6px 0 20px;
}

.draft-note {
  margin: 0 0 22px;
  max-width: none;
}

.proof {
  border: 2px solid var(--ink);
  background: var(--paper-raise);
  padding: clamp(16px, 2.4vw, 26px);
  margin-bottom: clamp(28px, 4vw, 44px);
}

.proof__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: var(--hairline);
}

.proof__kicker {
  font-family: var(--sans);
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--ink-faint);
}

.proof__title {
  font-family: var(--serif);
  font-size: clamp(20px, 2.6vw, 27px);
  letter-spacing: 0.04em;
  margin-top: 4px;
}

.proof__template {
  font-family: var(--sans);
  font-size: 11.5px;
  color: var(--ink-muted);
  margin-top: 4px;
}

.proof__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 12px 24px;
  margin: 16px 0 0;
}

.proof__facts dt {
  font-family: var(--sans);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--ink-faint);
}

.proof__facts dd {
  margin: 3px 0 0;
  font-size: 15px;
}

.proof__notice {
  max-width: none;
  margin: 16px 0 0;
}

.proof__sections {
  list-style: none;
  margin: 18px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.proof__section {
  border-top: 1px solid var(--rule);
  padding-top: 10px;
}

.proof__section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
}

.proof__section-head strong {
  font-family: var(--serif);
  font-size: 16px;
  letter-spacing: 0.04em;
}

.proof__section-head > span {
  font-family: var(--sans);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
}

.proof__section-count {
  margin-left: auto;
}

.proof__articles {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.proof__articles li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  font-size: 14.5px;
}

.proof__article-link {
  text-decoration: underline;
  text-decoration-color: var(--rule);
  text-underline-offset: 3px;
}

.proof__article-link:hover {
  text-decoration-color: var(--ink);
}

.proof__source {
  font-family: var(--sans);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
}

.proof__empty {
  margin-top: 18px;
  padding: 14px 16px;
  border-left: 3px solid var(--accent);
  background: var(--paper);
}

.proof__empty strong {
  font-size: 15px;
}

.proof__empty p {
  margin-top: 6px;
  font-size: 14px;
  color: var(--ink-muted);
}

.proof__hint {
  font-family: var(--sans);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ink-faint);
  margin: 8px 0 0;
}

.proof__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
  padding-top: 14px;
  border-top: var(--hairline);
}

@media (max-width: 720px) {
  .issue-actions {
    justify-content: flex-start;
  }

  .proof__section-count {
    margin-left: 0;
  }
}
</style>
