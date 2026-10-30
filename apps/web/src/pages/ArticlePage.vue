<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { ReadingStatus } from '@paper/shared';
import { ApiError, api } from '../api/client';
import { useAsync } from '../composables/useAsync';
import { useReaderPrefs } from '../composables/useReaderPrefs';
import { formatDateTime, paragraphList } from '../utils/format';
import SafeImage from '../components/SafeImage.vue';
import StateBlock from '../components/StateBlock.vue';

const route = useRoute();
const articleId = computed(() => Number(route.params.id));
const { data, loading, error, load } = useAsync(() => api.article(articleId.value));

const { fontSize, canIncrease, canDecrease, increase, decrease } = useReaderPrefs();

const saving = ref(false);
const saveError = ref('');

const extracting = ref(false);
const extractNotice = ref('');
const extractError = ref('');
const canExtract = computed(() => data.value !== null && data.value.accessLevel !== 'user_provided');

const manualOpen = ref(false);
const manualDraft = ref('');
const manualSaving = ref(false);
const manualError = ref('');
const manualNotice = ref('');
const manualCharacters = computed(() => manualDraft.value.replace(/\s+/g, '').length);

const noteDraft = ref('');
const noteSaving = ref(false);
const noteError = ref('');
const noteStatus = ref('');
const currentNote = computed(() => data.value?.note ?? '');
const noteDirty = computed(() => noteDraft.value !== currentNote.value);

watch(
  articleId,
  () => {
    noteDraft.value = '';
    noteError.value = '';
    noteStatus.value = '';
    extracting.value = false;
    extractNotice.value = '';
    extractError.value = '';
    manualOpen.value = false;
    manualDraft.value = '';
    manualSaving.value = false;
    manualError.value = '';
    manualNotice.value = '';
    void load();
  },
  { immediate: true },
);

watch(
  () => data.value?.id,
  () => {
    if (!data.value) return;
    noteDraft.value = data.value.note ?? '';
  },
  { immediate: true },
);

const paragraphs = computed(() => paragraphList(data.value?.contentText ?? null));

const accessLabel = computed(() => {
  switch (data.value?.accessLevel) {
    case 'user_provided':
      return '正文由你提供';
    case 'extracted':
      return '正文提取自公开页面';
    case 'metadata':
      return '仅有摘要，正文在原文';
    default:
      return '仅保存了链接';
  }
});

async function toggleStatus(status: ReadingStatus): Promise<void> {
  const article = data.value;
  if (!article || saving.value) return;
  saving.value = true;
  saveError.value = '';
  const next: ReadingStatus = article.readingStatus === status ? 'unread' : status;
  try {
    data.value = await api.setReadingState(article.id, { status: next });
  } catch (cause) {
    saveError.value = cause instanceof ApiError ? cause.message : '更新阅读状态失败，请重试';
  } finally {
    saving.value = false;
  }
}

async function extractBody(): Promise<void> {
  const article = data.value;
  if (!article || extracting.value) return;
  extracting.value = true;
  extractNotice.value = '';
  extractError.value = '';
  manualNotice.value = '';
  try {
    const result = await api.extractArticle(article.id);
    if (data.value?.id !== article.id) return;
    data.value = result.article;
    if (result.ok) {
      const characters = result.characters.toLocaleString('zh-CN');
      extractNotice.value = result.truncated
        ? `已保存前 ${characters} 字，原文更长，后半段请回原文阅读。`
        : `已提取 ${characters} 字，保存在本机。`;
      if (result.usedFallback) {
        extractNotice.value += ' 这页结构不规整，用的是主区块兜底结果，建议对照原文检查。';
      }
    } else {
      extractError.value = result.error?.message ?? '这次没有读到正文，已保留标题、摘要和原文链接。';
    }
  } catch (cause) {
    if (data.value?.id !== article.id) return;
    extractError.value = cause instanceof ApiError ? cause.message : '提取失败，请稍后重试';
  } finally {
    extracting.value = false;
  }
}

function toggleManual(): void {
  manualOpen.value = !manualOpen.value;
  manualError.value = '';
  manualNotice.value = '';
  if (manualOpen.value && !manualDraft.value && data.value?.accessLevel === 'user_provided') {
    manualDraft.value = data.value.contentText ?? '';
  }
}

async function saveManual(): Promise<void> {
  const article = data.value;
  if (!article || manualSaving.value) return;
  manualSaving.value = true;
  manualError.value = '';
  manualNotice.value = '';
  try {
    const updated = await api.saveManualContent(article.id, manualDraft.value);
    if (data.value?.id !== article.id) return;
    data.value = updated;
    manualDraft.value = updated.contentText ?? '';
    manualNotice.value = '正文已保存，并标记为「正文由你提供」。';
    extractNotice.value = '';
    extractError.value = '';
  } catch (cause) {
    if (data.value?.id !== article.id) return;
    manualError.value = cause instanceof ApiError ? cause.message : '保存正文失败，请重试';
  } finally {
    manualSaving.value = false;
  }
}

async function saveNote(): Promise<void> {
  const article = data.value;
  if (!article || noteSaving.value) return;
  noteSaving.value = true;
  noteError.value = '';
  noteStatus.value = '';
  try {
    const trimmed = noteDraft.value.trim();
    const updated = await api.setReadingState(article.id, { note: trimmed || null });
    data.value = updated;
    noteDraft.value = updated.note ?? '';
    noteStatus.value = updated.note ? '笔记已保存。' : '笔记已清空。';
  } catch (cause) {
    noteError.value = cause instanceof ApiError ? cause.message : '保存笔记失败，请重试';
  } finally {
    noteSaving.value = false;
  }
}

function resetNote(): void {
  noteDraft.value = currentNote.value;
  noteError.value = '';
  noteStatus.value = '';
}

function onNoteInput(): void {
  noteStatus.value = '';
}

</script>

<template>
  <div class="page">
    <StateBlock v-if="loading" variant="loading" />

    <StateBlock
      v-else-if="error"
      variant="error"
      mark="文章"
      title="这篇文章打不开"
      :hint="error"
      @retry="load"
    >
      <template #actions>
        <RouterLink to="/library" class="btn btn--quiet">回到文章库</RouterLink>
      </template>
    </StateBlock>

    <article
      v-else-if="data"
      class="reader"
      :style="{ '--reader-size': `${fontSize}px` }"
      aria-labelledby="article-title"
    >
      <RouterLink to="/" class="reader__back">← 回到今日报纸</RouterLink>

      <p class="reader__kicker">
        <span class="reader__kicker-source">{{ data.sourceName ?? '手动添加' }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ accessLabel }}</span>
      </p>

      <h1 id="article-title" class="reader__title">{{ data.title }}</h1>

      <p class="reader__byline">
        <span v-if="data.author">{{ data.author }}</span>
        <span v-if="data.author" aria-hidden="true">·</span>
        <time :datetime="data.publishedAt ?? undefined">{{ formatDateTime(data.publishedAt) }}</time>
        <span aria-hidden="true">·</span>
        <span v-if="data.hasFullText">约 {{ data.readMinutes }} 分钟</span>
        <span v-else>摘要，全文在原文</span>
      </p>

      <div class="reader__toolbar">
        <div class="fontctl" role="group" aria-label="正文字号">
          <span>字号</span>
          <button
            type="button"
            class="fontctl__btn"
            :disabled="!canDecrease"
            aria-label="减小字号"
            @click="decrease"
          >
            A−
          </button>
          <span class="fontctl__value">{{ fontSize }}px</span>
          <button
            type="button"
            class="fontctl__btn"
            :disabled="!canIncrease"
            aria-label="增大字号"
            @click="increase"
          >
            A+
          </button>
        </div>

        <div class="btn-row">
          <button
            type="button"
            class="btn"
            :aria-pressed="data.readingStatus === 'read'"
            :disabled="saving"
            @click="toggleStatus('read')"
          >
            {{ data.readingStatus === 'read' ? '已读' : '标记已读' }}
          </button>
          <button
            type="button"
            class="btn"
            :aria-pressed="data.readingStatus === 'later'"
            :disabled="saving"
            @click="toggleStatus('later')"
          >
            稍后读
          </button>
          <button
            v-if="canExtract"
            type="button"
            class="btn btn--quiet"
            :disabled="extracting"
            @click="extractBody"
          >
            {{ extracting ? '正在读取原文…' : data.hasFullText ? '重新提取正文' : '提取正文' }}
          </button>
        </div>
      </div>

      <p v-if="saveError" class="error-text" role="alert">{{ saveError }}</p>
      <p v-if="extractError" class="error-text" role="alert">{{ extractError }}</p>
      <p v-else-if="extractNotice" class="ok-text" role="status">{{ extractNotice }}</p>

      <div v-if="data.summary" class="summary-box">
        <span class="summary-box__label">
          {{ data.summaryIsSystem ? '摘要 · 系统生成，非原文' : '摘要 · 你提供的节选' }}
        </span>
        <p class="summary-box__text">{{ data.summary }}</p>
      </div>

      <SafeImage
        v-if="data.imageUrl"
        class="reader__figure"
        :src="data.imageUrl"
        :alt="data.title"
        :credit="data.sourceName"
        variant="feature"
      />

      <div v-if="paragraphs.length" class="reader__body">
        <p v-for="(paragraph, index) in paragraphs" :key="index">{{ paragraph }}</p>
      </div>

      <div v-else class="notice notice--wide">
        <strong>这一篇没有保存正文。</strong>
        本期只保留了标题、摘要和原文链接。抓取失败的页面不会用编造的内容补齐，请前往原网站阅读全文。
        <p v-if="data.extractError" class="notice__aside">
          上次提取没有成功：{{ data.extractError }}
        </p>
      </div>

      <p v-if="data.accessLevel === 'extracted' && paragraphs.length" class="reader__origin">
        <span>正文从公开页面提取，可能缺段或混入页面杂项；以原文为准。</span>
        <span v-if="data.extractedAt">提取于 {{ formatDateTime(data.extractedAt) }}</span>
      </p>
      <p
        v-if="data.extractError && data.hasFullText"
        class="reader__origin reader__origin--warn"
        role="status"
      >
        上次重新提取失败：{{ data.extractError }}。上面保留的是之前保存的正文。
      </p>

      <section class="paste" aria-labelledby="paste-title">
        <div class="paste__head">
          <h2 id="paste-title" class="paste__title">正文补充</h2>
          <span class="paste__hint">只存本机 · 确认你有权使用</span>
        </div>
        <button
          type="button"
          class="btn btn--quiet"
          :aria-expanded="manualOpen"
          @click="toggleManual"
        >
          {{
            manualOpen
              ? '收起'
              : data.accessLevel === 'user_provided'
                ? '编辑我提供的正文'
                : '粘贴我自己的正文'
          }}
        </button>

        <div v-if="manualOpen" class="paste__body">
          <p class="paste__note">
            保存后会替换当前正文，并标记为「正文由你提供」；公开页面提取不会覆盖它。请只粘贴你有权保存的内容。
          </p>
          <textarea
            v-model="manualDraft"
            class="field__input paste__input"
            rows="8"
            maxlength="200000"
            aria-label="我提供的正文"
            placeholder="粘贴正文，段落之间空一行。"
            :disabled="manualSaving"
          />
          <div class="paste__foot">
            <span>{{ manualCharacters }} 字 · 上限 200000 字符</span>
            <div class="btn-row">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="manualSaving || manualCharacters < 20"
                @click="saveManual"
              >
                {{ manualSaving ? '保存中…' : '保存正文' }}
              </button>
              <button
                type="button"
                class="btn btn--quiet"
                :disabled="manualSaving"
                @click="manualOpen = false"
              >
                取消
              </button>
            </div>
          </div>
          <p v-if="manualError" class="error-text" role="alert">{{ manualError }}</p>
          <p v-else-if="manualNotice" class="ok-text" role="status">{{ manualNotice }}</p>
        </div>
      </section>

      <div class="reader__end">
        <p class="reader__end-note">
          原文由「{{ data.sourceName ?? '未知来源' }}」发布，链接可能随时间失效；摘要是辅助判断，不代替原文。
        </p>
        <a
          class="btn btn--primary reader__external"
          :href="data.originalUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          前往原网站阅读 <span aria-hidden="true">↗</span>
        </a>
      </div>

      <section class="note" aria-labelledby="reader-note-title">
        <div class="note__head">
          <h2 id="reader-note-title" class="note__title">我的笔记</h2>
          <span class="note__hint">只存在本机，不会同步</span>
        </div>
        <textarea
          v-model="noteDraft"
          class="field__input note__input"
          rows="4"
          maxlength="4000"
          aria-label="我的笔记"
          placeholder="记下想法、疑问，或者想再回来看的一句。"
          :disabled="noteSaving || !data"
          @input="onNoteInput"
        />
        <div class="note__foot">
          <span class="note__count">{{ noteDraft.length }} / 4000</span>
          <div class="btn-row">
            <button
              type="button"
              class="btn btn--primary"
              :disabled="!noteDirty || noteSaving"
              @click="saveNote"
            >
              {{ noteSaving ? '保存中…' : '保存笔记' }}
            </button>
            <button type="button" class="btn btn--quiet" :disabled="!noteDirty || noteSaving" @click="resetNote">
              撤销
            </button>
          </div>
        </div>
        <p v-if="noteError" class="error-text" role="alert">{{ noteError }}</p>
        <p v-else-if="noteStatus" class="ok-text" role="status">{{ noteStatus }}</p>
      </section>

      <nav class="reader__next" aria-label="读完后">
        <p class="reader__next-label">读完了</p>
        <div class="btn-row">
          <RouterLink to="/" class="btn">回到今日报纸</RouterLink>
          <RouterLink to="/library" class="btn btn--quiet">整理文章库</RouterLink>
        </div>
      </nav>
    </article>
  </div>
</template>

<style scoped>
.notice__aside {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--rule);
  font-size: 12px;
  color: var(--ink-faint);
}

.reader__origin {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 16px;
  margin-top: 18px;
  padding-top: 12px;
  border-top: var(--hairline);
  font-family: var(--sans);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ink-faint);
}

.reader__origin--warn {
  color: var(--accent);
}

.paste {
  margin-top: clamp(26px, 3.6vw, 40px);
  padding-top: 18px;
  border-top: 1px solid var(--rule-strong);
}

.paste__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.paste__title {
  font-family: var(--sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--ink-muted);
}

.paste__hint {
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink-faint);
}

.paste__body {
  margin-top: 12px;
}

.paste__note {
  margin-bottom: 10px;
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.8;
  color: var(--ink-muted);
}

.paste__input {
  min-height: 12em;
  background: var(--paper-raise);
  font-family: var(--serif);
  font-size: 15px;
  line-height: 1.85;
}

.paste__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-top: 10px;
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink-faint);
}

.paste__foot .btn-row {
  margin: 0;
}

.note {
  margin-top: clamp(28px, 4vw, 44px);
  padding-top: 18px;
  border-top: 1px solid var(--rule-strong);
}

.note__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.note__title {
  font-family: var(--sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--ink-muted);
}

.note__hint,
.note__count {
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink-faint);
}

.note__input {
  min-height: 7.5em;
  background: var(--paper-raise);
  font-family: var(--serif);
  font-size: 15px;
  line-height: 1.85;
}

.note__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-top: 10px;
}

.note__foot .btn-row {
  margin: 0;
}
</style>

