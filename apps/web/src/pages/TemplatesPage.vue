<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  DEFAULT_THEME,
  type LayoutType,
  type TemplateSectionFilter,
  type TemplateSortRule,
  type TemplateView,
  type ThemeSettings,
} from '@paper/shared';
import { api, ApiError, type TemplatePayload } from '../api/client';
import { useAsync } from '../composables/useAsync';
import StateBlock from '../components/StateBlock.vue';

const layoutOptions: Array<{ value: LayoutType; label: string }> = [
  { value: 'headline', label: '头条' },
  { value: 'feature', label: '大图 · 深读' },
  { value: 'double', label: '双栏' },
  { value: 'list', label: '列表' },
  { value: 'brief', label: '简讯' },
];

const layoutLabel: Record<string, string> = Object.fromEntries(
  layoutOptions.map((option) => [option.value, option.label]),
);

interface SectionDraft {
  key: string;
  id: number | null;
  name: string;
  layoutType: LayoutType;
  maxArticles: number;
  filter: TemplateSectionFilter;
  sortRule: TemplateSortRule;
}

interface TemplateDraft {
  id: number | null;
  name: string;
  mastheadTitle: string;
  subtitle: string;
  dateFormat: string;
  theme: ThemeSettings;
  maxTotalArticles: number;
  isDefault: boolean;
  sections: SectionDraft[];
}

let sectionKeySeq = 0;

function newSection(patch: Partial<SectionDraft> = {}): SectionDraft {
  sectionKeySeq += 1;
  return {
    key: `section-${sectionKeySeq}`,
    id: null,
    name: '新栏目',
    layoutType: 'list',
    maxArticles: 4,
    filter: { sourceIds: [], maxAgeDays: 7 },
    sortRule: 'published_desc',
    ...patch,
  };
}

function blankTemplate(): TemplateDraft {
  return {
    id: null,
    name: '新模板',
    mastheadTitle: '纸间',
    subtitle: '',
    dateFormat: 'YYYY年M月D日 dddd',
    theme: { ...DEFAULT_THEME },
    maxTotalArticles: 15,
    isDefault: false,
    sections: [newSection({ name: '头版', layoutType: 'headline', maxArticles: 3 })],
  };
}

function cloneTemplate(view: TemplateView): TemplateDraft {
  return {
    id: view.id,
    name: view.name,
    mastheadTitle: view.mastheadTitle,
    subtitle: view.subtitle,
    dateFormat: view.dateFormat,
    theme: { ...view.theme },
    maxTotalArticles: view.maxTotalArticles,
    isDefault: view.isDefault,
    sections: view.sections.map((section) =>
      newSection({
        id: section.id,
        name: section.name,
        layoutType: section.layoutType,
        maxArticles: section.maxArticles,
        filter: {
          ...section.filter,
          sourceIds: [...(section.filter.sourceIds ?? [])],
          maxAgeDays: section.filter.maxAgeDays ?? 7,
        },
        sortRule: section.sortRule,
      }),
    ),
  };
}

function serialize(draft: TemplateDraft): string {
  return JSON.stringify({
    name: draft.name,
    mastheadTitle: draft.mastheadTitle,
    subtitle: draft.subtitle,
    dateFormat: draft.dateFormat,
    theme: draft.theme,
    maxTotalArticles: draft.maxTotalArticles,
    sections: draft.sections.map((section) => ({
      name: section.name,
      layoutType: section.layoutType,
      maxArticles: section.maxArticles,
      filter: section.filter,
      sortRule: section.sortRule,
    })),
  });
}

const { data: templateData, loading, error, load } = useAsync(() => api.templates());
const { data: sourceData, load: loadSources } = useAsync(() => api.sources());

const draft = ref<TemplateDraft>(blankTemplate());
const baseline = ref(serialize(draft.value));
const initialized = ref(false);
const busy = ref(false);
const notice = ref('');
const failure = ref('');

const templates = computed(() => templateData.value?.items ?? []);
const sources = computed(() => sourceData.value?.items ?? []);
const dirty = computed(() => serialize(draft.value) !== baseline.value);

watch(
  templateData,
  (value) => {
    if (initialized.value || !value || value.items.length === 0) return;
    const first = value.items.find((template) => template.isDefault) ?? value.items[0];
    if (!first) return;
    draft.value = cloneTemplate(first);
    baseline.value = serialize(draft.value);
    initialized.value = true;
  },
  { immediate: true },
);

onMounted(async () => {
  await Promise.all([load(), loadSources()]);
});

function describe(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : '操作失败，请稍后重试。';
}

function applyTemplate(view: TemplateView): void {
  draft.value = cloneTemplate(view);
  baseline.value = serialize(draft.value);
  failure.value = '';
  initialized.value = true;
}

function selectTemplate(view: TemplateView): void {
  if (view.id === draft.value.id) return;
  if (dirty.value) {
    failure.value = '有未保存的修改。先保存，或点“撤销修改”再切换模板。';
    return;
  }
  notice.value = '';
  applyTemplate(view);
}

function startNew(): void {
  if (dirty.value) {
    failure.value = '有未保存的修改。先保存，或点“撤销修改”再新建模板。';
    return;
  }
  draft.value = blankTemplate();
  baseline.value = serialize(draft.value);
  notice.value = '这是一个尚未保存的模板，保存后才会出现在左上角的列表里。';
  failure.value = '';
  initialized.value = true;
}

function discard(): void {
  const saved = templates.value.find((template) => template.id === draft.value.id);
  if (saved) {
    applyTemplate(saved);
    notice.value = '已撤销未保存的修改。';
  } else {
    draft.value = blankTemplate();
    baseline.value = serialize(draft.value);
    notice.value = '已清空新建中的模板。';
  }
  failure.value = '';
}

async function copyCurrent(): Promise<void> {
  if (draft.value.id === null) {
    failure.value = '先保存当前模板，再复制。';
    return;
  }
  busy.value = true;
  failure.value = '';
  notice.value = '';
  try {
    const copied = await api.copyTemplate(draft.value.id);
    await load();
    applyTemplate(copied);
    notice.value = '已复制出一个独立模板，改它不会影响原模板。';
  } catch (cause) {
    failure.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

async function makeDefault(): Promise<void> {
  if (draft.value.id === null) {
    failure.value = '先保存模板，才能设为默认。';
    return;
  }
  busy.value = true;
  failure.value = '';
  notice.value = '';
  try {
    const updated = await api.setDefaultTemplate(draft.value.id);
    await load();
    applyTemplate(updated);
    notice.value = '已设为默认模板。之后生成报纸时会先找它。';
  } catch (cause) {
    failure.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

function cleanFilter(filter: TemplateSectionFilter): TemplateSectionFilter {
  const result: TemplateSectionFilter = {};
  if (filter.sourceIds && filter.sourceIds.length > 0) result.sourceIds = [...filter.sourceIds];
  if (filter.maxAgeDays) result.maxAgeDays = filter.maxAgeDays;
  if (filter.pinnedArticleIds && filter.pinnedArticleIds.length > 0) {
    result.pinnedArticleIds = [...filter.pinnedArticleIds];
  }
  return result;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function toPayload(): TemplatePayload {
  return {
    name: draft.value.name.trim(),
    mastheadTitle: draft.value.mastheadTitle.trim(),
    subtitle: draft.value.subtitle.trim(),
    dateFormat: draft.value.dateFormat.trim(),
    theme: {
      ...draft.value.theme,
      bodyFontSize: clamp(draft.value.theme.bodyFontSize, 12, 24, 17),
      bodyLineHeight: Math.min(2.4, Math.max(1.2, Number(draft.value.theme.bodyLineHeight) || 1.85)),
      contentWidth: clamp(draft.value.theme.contentWidth, 720, 1600, 1180),
    },
    maxTotalArticles: clamp(draft.value.maxTotalArticles, 1, 50, 15),
    sections: draft.value.sections.map((section) => ({
      name: section.name.trim(),
      layoutType: section.layoutType,
      maxArticles: clamp(section.maxArticles, 1, 30, 4),
      filter: {
        ...cleanFilter(section.filter),
        maxAgeDays: clamp(section.filter.maxAgeDays, 1, 365, 7),
      },
      sortRule: section.sortRule,
    })),
  };
}

function validate(): string | null {
  if (!draft.value.name.trim()) return '模板名不能为空。';
  if (!draft.value.mastheadTitle.trim()) return '刊名不能为空。';
  if (!draft.value.dateFormat.trim()) return '日期格式不能为空。';
  if (draft.value.sections.length === 0) return '至少保留一个栏目。';
  const names = new Set<string>();
  for (const section of draft.value.sections) {
    const name = section.name.trim();
    if (!name) return '栏目名不能为空。';
    if (names.has(name)) return `栏目名重复：${name}`;
    names.add(name);
  }
  return null;
}

async function save(): Promise<void> {
  const problem = validate();
  if (problem) {
    failure.value = problem;
    return;
  }
  const wasNew = draft.value.id === null;
  busy.value = true;
  failure.value = '';
  notice.value = '';
  try {
    const payload = toPayload();
    const saved = wasNew
      ? await api.createTemplate(payload)
      : await api.updateTemplate(draft.value.id!, payload);
    await load();
    applyTemplate(saved);
    notice.value = wasNew
      ? '模板已创建。'
      : '模板已保存。已经出过的期刊仍按当时的快照显示，不会跟着变。';
  } catch (cause) {
    failure.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

function addSection(): void {
  let index = draft.value.sections.length + 1;
  let name = `新栏目 ${index}`;
  while (draft.value.sections.some((section) => section.name === name)) {
    index += 1;
    name = `新栏目 ${index}`;
  }
  draft.value.sections.push(newSection({ name }));
}

function removeSection(index: number): void {
  if (draft.value.sections.length <= 1) {
    failure.value = '至少保留一个栏目。';
    return;
  }
  draft.value.sections.splice(index, 1);
}

function moveSection(index: number, delta: number): void {
  const target = index + delta;
  const current = draft.value.sections[index];
  const other = draft.value.sections[target];
  if (!current || !other) return;
  draft.value.sections[index] = other;
  draft.value.sections[target] = current;
}

function isSourceOn(section: SectionDraft, sourceId: number): boolean {
  return (section.filter.sourceIds ?? []).includes(sourceId);
}

function toggleSource(section: SectionDraft, sourceId: number): void {
  const ids = section.filter.sourceIds ?? [];
  section.filter.sourceIds = ids.includes(sourceId)
    ? ids.filter((id) => id !== sourceId)
    : [...ids, sourceId];
}

const previewStyle = computed<Record<string, string>>(() => ({
  background: draft.value.theme.paper,
  color: draft.value.theme.ink,
  '--pv-ink': draft.value.theme.ink,
  '--pv-muted': draft.value.theme.inkMuted,
  '--pv-rule': draft.value.theme.rule,
  '--pv-accent': draft.value.theme.accent,
  '--pv-size': `${draft.value.theme.bodyFontSize}px`,
  '--pv-line': String(draft.value.theme.bodyLineHeight),
}));
</script>

<template>
  <div class="page">
    <header class="page-head">
      <p class="page-head__kicker">TEMPLATE · 版式规则</p>
      <h1 class="page-head__title">模板编辑器</h1>
      <p class="page-head__hint">
        模板决定刊名、主题、栏目顺序、每栏容量和选稿范围。改模板只影响之后生成的期刊；
        已经出过的报纸按生成当时的快照保留。
      </p>
    </header>

    <StateBlock v-if="loading" variant="loading" />

    <StateBlock
      v-else-if="error"
      variant="error"
      mark="模板"
      title="模板没能取回来"
      :hint="error"
      @retry="load"
    />

    <template v-else>
      <div class="tpl-bar">
        <div class="tpl-bar__list" role="group" aria-label="选择模板">
          <button
            v-for="template in templates"
            :key="template.id"
            type="button"
            class="tpl-chip"
            :class="{ 'tpl-chip--active': template.id === draft.id }"
            :aria-pressed="template.id === draft.id"
            @click="selectTemplate(template)"
          >
            {{ template.name }}
            <span v-if="template.isDefault" class="tpl-chip__badge">默认</span>
          </button>
          <span v-if="templates.length === 0" class="tpl-bar__empty">
            还没有保存的模板；下面是一个可以保存的新模板。
          </span>
        </div>
        <div class="tpl-bar__actions">
          <button type="button" class="btn btn--quiet" :disabled="busy" @click="startNew">新建模板</button>
          <button
            type="button"
            class="btn btn--quiet"
            :disabled="busy || draft.id === null"
            @click="copyCurrent"
          >
            复制当前
          </button>
        </div>
      </div>

      <p v-if="notice" class="ok-text tpl-message" role="status">{{ notice }}</p>
      <p v-if="failure" class="notice notice--error tpl-message" role="alert">{{ failure }}</p>
      <p v-if="dirty" class="tpl-dirty">
        有未保存的修改
        <button type="button" class="link-btn" @click="discard">撤销修改</button>
      </p>

      <div class="tpl-layout">
        <div class="tpl-editor">
          <section aria-labelledby="tpl-masthead">
            <div class="section__head">
              <h2 id="tpl-masthead" class="section__name">刊头</h2>
              <span class="section__page">报头文字</span>
              <span class="section__count">{{ draft.id === null ? '未保存' : `#${draft.id}` }}</span>
            </div>
            <div class="field-grid">
              <label class="field">
                <span class="field__label">模板名</span>
                <input v-model="draft.name" class="field__input" maxlength="60" />
              </label>
              <label class="field">
                <span class="field__label">刊名</span>
                <input v-model="draft.mastheadTitle" class="field__input" maxlength="40" />
              </label>
              <label class="field field--wide">
                <span class="field__label">副标题</span>
                <input v-model="draft.subtitle" class="field__input" maxlength="160" />
              </label>
              <label class="field">
                <span class="field__label">日期格式</span>
                <input v-model="draft.dateFormat" class="field__input" maxlength="60" />
              </label>
              <label class="field">
                <span class="field__label">整期容量上限（篇）</span>
                <input
                  v-model.number="draft.maxTotalArticles"
                  class="field__input"
                  type="number"
                  min="1"
                  max="50"
                />
              </label>
            </div>
            <p class="tpl-hint">
              日期格式使用 YYYY / MM / DD / dddd（星期）占位；容量上限是所有栏目加起来的总篇数。
            </p>
          </section>

          <section aria-labelledby="tpl-theme" class="tpl-block">
            <div class="section__head">
              <h2 id="tpl-theme" class="section__name">主题</h2>
              <span class="section__page">纸张 / 墨色 / 字号</span>
            </div>
            <div class="color-grid">
              <label class="field">
                <span class="field__label">纸张</span>
                <span class="color-row">
                  <input v-model="draft.theme.paper" type="color" aria-label="纸张颜色" />
                  <code>{{ draft.theme.paper }}</code>
                </span>
              </label>
              <label class="field">
                <span class="field__label">主墨色</span>
                <span class="color-row">
                  <input v-model="draft.theme.ink" type="color" aria-label="主墨色" />
                  <code>{{ draft.theme.ink }}</code>
                </span>
              </label>
              <label class="field">
                <span class="field__label">次要墨色</span>
                <span class="color-row">
                  <input v-model="draft.theme.inkMuted" type="color" aria-label="次要墨色" />
                  <code>{{ draft.theme.inkMuted }}</code>
                </span>
              </label>
              <label class="field">
                <span class="field__label">分隔线</span>
                <span class="color-row">
                  <input v-model="draft.theme.rule" type="color" aria-label="分隔线颜色" />
                  <code>{{ draft.theme.rule }}</code>
                </span>
              </label>
              <label class="field">
                <span class="field__label">强调色</span>
                <span class="color-row">
                  <input v-model="draft.theme.accent" type="color" aria-label="强调色" />
                  <code>{{ draft.theme.accent }}</code>
                </span>
              </label>
            </div>
            <div class="field-grid tpl-block">
              <label class="field">
                <span class="field__label">纸张纹理</span>
                <select v-model="draft.theme.paperTexture" class="field__input">
                  <option value="grain">细颗粒</option>
                  <option value="plain">纯色</option>
                </select>
              </label>
              <label class="field">
                <span class="field__label">正文字号：{{ draft.theme.bodyFontSize }}px</span>
                <input
                  v-model.number="draft.theme.bodyFontSize"
                  class="range"
                  type="range"
                  min="12"
                  max="24"
                  step="1"
                />
              </label>
              <label class="field">
                <span class="field__label">正文行高：{{ draft.theme.bodyLineHeight }}</span>
                <input
                  v-model.number="draft.theme.bodyLineHeight"
                  class="range"
                  type="range"
                  min="1.2"
                  max="2.4"
                  step="0.05"
                />
              </label>
              <label class="field">
                <span class="field__label">版心宽度：{{ draft.theme.contentWidth }}px</span>
                <input
                  v-model.number="draft.theme.contentWidth"
                  class="range"
                  type="range"
                  min="720"
                  max="1600"
                  step="20"
                />
              </label>
            </div>
          </section>

          <section aria-labelledby="tpl-sections" class="tpl-block">
            <div class="section__head">
              <h2 id="tpl-sections" class="section__name">栏目与版式</h2>
              <span class="section__page">从上到下就是版面顺序</span>
              <span class="section__count">{{ draft.sections.length }} 个栏目</span>
            </div>

            <ol class="tpl-sections">
              <li v-for="(section, index) in draft.sections" :key="section.key" class="tpl-section">
                <div class="tpl-section__top">
                  <span class="tpl-section__index" aria-hidden="true">{{ index + 1 }}</span>
                  <input
                    v-model="section.name"
                    class="field__input tpl-section__name"
                    maxlength="20"
                    :aria-label="`第 ${index + 1} 个栏目的名称`"
                  />
                  <div class="tpl-section__tools">
                    <button
                      type="button"
                      class="icon-btn"
                      :disabled="index === 0"
                      :aria-label="`上移第 ${index + 1} 个栏目`"
                      @click="moveSection(index, -1)"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="icon-btn"
                      :disabled="index === draft.sections.length - 1"
                      :aria-label="`下移第 ${index + 1} 个栏目`"
                      @click="moveSection(index, 1)"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="icon-btn icon-btn--danger"
                      :disabled="draft.sections.length <= 1"
                      :aria-label="`删除第 ${index + 1} 个栏目`"
                      @click="removeSection(index)"
                    >
                      ×
                    </button>
                  </div>
                </div>

                <div class="field-grid field-grid--four">
                  <label class="field">
                    <span class="field__label">版式</span>
                    <select v-model="section.layoutType" class="field__input">
                      <option v-for="option in layoutOptions" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="field__label">本栏上限（篇）</span>
                    <input v-model.number="section.maxArticles" class="field__input" type="number" min="1" max="30" />
                  </label>
                  <label class="field">
                    <span class="field__label">回溯天数</span>
                    <input v-model.number="section.filter.maxAgeDays" class="field__input" type="number" min="1" max="365" />
                  </label>
                  <label class="field">
                    <span class="field__label">排序</span>
                    <select v-model="section.sortRule" class="field__input">
                      <option value="published_desc">按发布时间</option>
                      <option value="source_priority">按来源勾选顺序</option>
                    </select>
                  </label>
                </div>

                <fieldset class="tpl-sources">
                  <legend>
                    来源筛选
                    <span>不勾选 = 所有启用来源；勾选顺序就是“按来源排序”的优先级</span>
                  </legend>
                  <div v-if="sources.length > 0" class="tpl-sources__list">
                    <label
                      v-for="source in sources"
                      :key="source.id"
                      class="source-check"
                      :class="{ 'source-check--off': !source.enabled }"
                    >
                      <input
                        type="checkbox"
                        :checked="isSourceOn(section, source.id)"
                        @change="toggleSource(section, source.id)"
                      />
                      {{ source.name }}
                      <span v-if="!source.enabled">已停用</span>
                    </label>
                  </div>
                  <p v-else class="tpl-hint">还没有来源可选，先去「信息来源」添加一个。</p>
                </fieldset>
              </li>
            </ol>

            <button type="button" class="btn btn--quiet" @click="addSection">添加栏目</button>
          </section>

          <div class="tpl-actions">
            <button type="button" class="btn btn--primary" :disabled="busy" @click="save">
              {{ draft.id === null ? '创建模板' : '保存修改' }}
            </button>
            <button
              type="button"
              class="btn"
              :disabled="busy || draft.id === null || draft.isDefault"
              @click="makeDefault"
            >
              {{ draft.isDefault ? '当前默认模板' : '设为默认' }}
            </button>
            <button type="button" class="btn btn--quiet" :disabled="!dirty" @click="discard">
              撤销修改
            </button>
            <span v-if="dirty" class="tpl-actions__hint">保存不会改动已经生成的期刊。</span>
          </div>
        </div>

        <aside class="tpl-preview" :style="previewStyle" aria-label="模板版式示意">
          <p class="tpl-preview__tag">版式示意 · 不是实际文章</p>
          <div class="tpl-preview__masthead">
            <span class="tpl-preview__dateline">2026年10月28日 星期三 · 第 1 期</span>
            <h2>{{ draft.mastheadTitle || '刊名' }}</h2>
            <p v-if="draft.subtitle">{{ draft.subtitle }}</p>
            <div class="tpl-preview__rule" aria-hidden="true"></div>
          </div>

          <div
            v-for="section in draft.sections"
            :key="`preview-${section.key}`"
            class="pv-section"
          >
            <div class="pv-section__head">
              <strong>{{ section.name || '未命名栏目' }}</strong>
              <span>{{ layoutLabel[section.layoutType] }} · 最多 {{ section.maxArticles }} 篇</span>
            </div>

            <div v-if="section.layoutType === 'headline'" class="pv-headline">
              <div class="pv-lead">
                <span class="pv-title"></span>
                <span class="pv-line"></span>
                <span class="pv-line pv-line--short"></span>
              </div>
              <div class="pv-sides">
                <div
                  v-for="n in Math.max(0, Math.min(section.maxArticles, 2) - 1)"
                  :key="n"
                  class="pv-side"
                >
                  <span class="pv-title pv-title--sm"></span>
                  <span class="pv-line"></span>
                </div>
              </div>
            </div>

            <div v-else-if="section.layoutType === 'double'" class="pv-grid pv-grid--two">
              <div v-for="n in Math.max(1, Math.min(section.maxArticles, 2))" :key="n" class="pv-story">
                <span class="pv-title pv-title--sm"></span>
                <span class="pv-line"></span>
                <span class="pv-line"></span>
              </div>
            </div>

            <div v-else-if="section.layoutType === 'feature'" class="pv-feature">
              <div
                v-for="n in Math.max(1, Math.min(section.maxArticles, 2))"
                :key="n"
                class="pv-feature__row"
              >
                <span class="pv-image"></span>
                <div class="pv-feature__text">
                  <span class="pv-title pv-title--sm"></span>
                  <span class="pv-line"></span>
                  <span class="pv-line pv-line--short"></span>
                </div>
              </div>
            </div>

            <div v-else-if="section.layoutType === 'list'" class="pv-list">
              <div
                v-for="n in Math.max(1, Math.min(section.maxArticles, 4))"
                :key="n"
                class="pv-list__row"
              >
                <span class="pv-num">{{ n }}</span>
                <div>
                  <span class="pv-title pv-title--xs"></span>
                  <span class="pv-line"></span>
                </div>
              </div>
            </div>

            <div v-else class="pv-brief">
              <div
                v-for="n in Math.max(1, Math.min(section.maxArticles, 4))"
                :key="n"
                class="pv-brief__item"
              >
                <span class="pv-title pv-title--xs"></span>
                <span class="pv-line"></span>
              </div>
            </div>
          </div>

          <p class="tpl-preview__foot">
            容量 {{ draft.maxTotalArticles }} 篇 · 版心 {{ draft.theme.contentWidth }}px · 正文
            {{ draft.theme.bodyFontSize }}px / 行高 {{ draft.theme.bodyLineHeight }}
          </p>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tpl-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 18px;
  padding-bottom: 14px;
  border-bottom: var(--hairline);
}

.tpl-bar__list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.tpl-chip {
  font-family: var(--sans);
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--ink-muted);
  background: transparent;
  border: 1px solid var(--rule);
  padding: 6px 11px;
  cursor: pointer;
}

.tpl-chip:hover {
  border-color: var(--rule-strong);
  color: var(--ink);
}

.tpl-chip--active {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper);
}

.tpl-chip__badge {
  margin-left: 6px;
  font-size: 10px;
  opacity: 0.75;
}

.tpl-bar__empty {
  font-family: var(--sans);
  font-size: 12px;
  color: var(--ink-faint);
}

.tpl-bar__actions {
  display: flex;
  gap: 8px;
}

.tpl-message {
  margin: 16px 0 0;
}

.tpl-dirty {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 0;
  font-family: var(--sans);
  font-size: 12px;
  color: var(--accent);
}

.link-btn {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}

.tpl-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: clamp(24px, 3vw, 42px);
  align-items: start;
  margin-top: clamp(20px, 3vw, 32px);
}

.tpl-block {
  margin-top: clamp(28px, 4vw, 44px);
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 20px;
}

.field-grid--four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.field--wide {
  grid-column: 1 / -1;
}

.tpl-hint {
  margin: 12px 0 0;
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.75;
  color: var(--ink-faint);
}

.color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: 16px 20px;
}

.color-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-row input[type='color'] {
  width: 34px;
  height: 30px;
  padding: 2px;
  border: 1px solid var(--rule);
  background: var(--paper-raise);
  cursor: pointer;
}

.color-row code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--ink-muted);
}

.range {
  width: 100%;
  accent-color: var(--accent);
}

.tpl-sections {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tpl-section {
  border: 1px solid var(--rule);
  background: var(--paper-raise);
  padding: 14px 16px 16px;
}

.tpl-section__top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.tpl-section__index {
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink-faint);
  min-width: 1.6em;
}

.tpl-section__name {
  flex: 1;
  min-width: 0;
  font-size: 15px;
}

.tpl-section__tools {
  display: flex;
  gap: 4px;
}

.icon-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rule);
  background: transparent;
  color: var(--ink-muted);
  font-size: 15px;
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  border-color: var(--rule-strong);
  color: var(--ink);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.icon-btn--danger:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

.tpl-sources {
  border: 0;
  border-top: var(--hairline);
  margin: 14px 0 0;
  padding: 12px 0 0;
}

.tpl-sources legend {
  font-family: var(--sans);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  padding: 0;
}

.tpl-sources legend span {
  letter-spacing: 0;
  margin-left: 6px;
}

.tpl-sources__list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 8px;
}

.source-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--sans);
  font-size: 12px;
  color: var(--ink-muted);
  cursor: pointer;
}

.source-check input {
  accent-color: var(--accent);
}

.source-check--off {
  color: var(--ink-faint);
}

.source-check--off span {
  font-size: 10px;
  border: 1px solid var(--rule);
  padding: 0 3px;
}

.tpl-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: clamp(24px, 3vw, 34px);
  padding-top: 18px;
  border-top: 2px solid var(--ink);
}

.tpl-actions__hint {
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink-faint);
}

.tpl-preview {
  position: sticky;
  top: 18px;
  padding: 18px;
  border: 1px solid var(--pv-rule);
  box-shadow: 0 0 0 1px rgba(28, 26, 22, 0.04);
  font-size: var(--pv-size);
  line-height: var(--pv-line);
}

.tpl-preview__tag {
  font-family: var(--sans);
  font-size: 9.5px;
  letter-spacing: 0.16em;
  color: color-mix(in srgb, var(--pv-ink) 62%, transparent);
  margin-bottom: 14px;
}

.tpl-preview__dateline {
  display: block;
  font-family: var(--sans);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--pv-muted);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--pv-rule);
}

.tpl-preview__masthead h2 {
  font-family: var(--serif);
  font-size: 30px;
  line-height: 1.15;
  letter-spacing: 0.12em;
  text-align: center;
  text-indent: 0.12em;
  padding: 12px 0 6px;
  color: var(--pv-ink);
}

.tpl-preview__masthead p {
  text-align: center;
  font-size: 10.5px;
  letter-spacing: 0.2em;
  text-indent: 0.2em;
  color: var(--pv-muted);
  padding-bottom: 8px;
}

.tpl-preview__rule {
  border-top: 3px double var(--pv-ink);
  border-bottom: 1px solid var(--pv-ink);
  height: 3px;
  margin-bottom: 14px;
  opacity: 0.7;
}

.pv-section {
  margin-bottom: 16px;
}

.pv-section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  border-top: 1.5px solid var(--pv-ink);
  padding-top: 6px;
  margin-bottom: 8px;
}

.pv-section__head strong {
  font-family: var(--serif);
  font-size: 13px;
  letter-spacing: 0.05em;
  color: var(--pv-ink);
}

.pv-section__head span {
  font-family: var(--sans);
  font-size: 8.5px;
  letter-spacing: 0.05em;
  color: var(--pv-muted);
}

.pv-title,
.pv-line,
.pv-image {
  display: block;
  background: color-mix(in srgb, var(--pv-ink) 20%, transparent);
  border-radius: 1px;
}

.pv-title {
  height: 9px;
  width: 88%;
  background: color-mix(in srgb, var(--pv-ink) 55%, transparent);
  margin-bottom: 5px;
}

.pv-title--sm {
  height: 7px;
  width: 78%;
}

.pv-title--xs {
  height: 6px;
  width: 70%;
  margin-bottom: 4px;
}

.pv-line {
  height: 3px;
  margin-bottom: 4px;
}

.pv-line--short {
  width: 58%;
}

.pv-headline {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: 10px;
}

.pv-lead {
  border-right: 1px solid var(--pv-rule);
  padding-right: 10px;
}

.pv-lead .pv-title {
  height: 12px;
  width: 94%;
}

.pv-sides {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pv-side {
  padding-bottom: 7px;
  border-bottom: 1px solid var(--pv-rule);
}

.pv-side:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.pv-grid--two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.pv-story {
  border-top: 1px solid var(--pv-rule);
  padding-top: 6px;
}

.pv-feature__row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}

.pv-image {
  height: 42px;
  background: color-mix(in srgb, var(--pv-ink) 12%, transparent);
}

.pv-list__row {
  display: flex;
  gap: 7px;
  padding: 5px 0;
  border-bottom: 1px solid var(--pv-rule);
}

.pv-list__row:last-child {
  border-bottom: 0;
}

.pv-list__row > div {
  flex: 1;
  min-width: 0;
}

.pv-num {
  font-family: var(--sans);
  font-size: 9px;
  color: var(--pv-muted);
  min-width: 1em;
}

.pv-brief {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px 10px;
}

.pv-brief__item {
  border-left: 2px solid var(--pv-rule);
  padding-left: 6px;
}

.tpl-preview__foot {
  margin-top: 14px;
  padding-top: 8px;
  border-top: 1px solid var(--pv-rule);
  font-family: var(--sans);
  font-size: 9px;
  letter-spacing: 0.04em;
  color: var(--pv-muted);
}

@media (max-width: 1080px) {
  .tpl-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .tpl-preview {
    position: static;
    max-width: 460px;
  }
}

@media (max-width: 720px) {
  .field-grid,
  .field-grid--four {
    grid-template-columns: minmax(0, 1fr);
  }

  .tpl-bar__actions {
    width: 100%;
  }

  .tpl-section {
    padding: 12px;
  }

  .tpl-section__top {
    flex-wrap: wrap;
  }

  .tpl-section__name {
    flex-basis: calc(100% - 60px);
  }
}
</style>
