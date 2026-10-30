<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { IssuePreview, JobRunSummary, ScheduleSettings } from '@paper/shared';
import { api, ApiError } from '../api/client';
import { useAsync } from '../composables/useAsync';
import { formatDateTime } from '../utils/format';
import StateBlock from '../components/StateBlock.vue';

const {
  data: settingsData,
  loading: settingsLoading,
  error: settingsError,
  load: loadSettings,
} = useAsync(() => api.settings());
const { data: statusData, load: loadStatus } = useAsync(() => api.jobStatus());
const { data: backupData, error: backupError, load: loadBackups } = useAsync(() => api.backups());

const schedule = ref<ScheduleSettings | null>(null);
const saving = ref(false);
const running = ref(false);
const backingUp = ref(false);
const jobNotice = ref('');
const jobError = ref('');

const timeZone = computed(() => schedule.value?.timeZone ?? 'Asia/Shanghai');

const COMMON_ZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

const timeZones = computed(() => {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
    'timeZone',
  );
  const list = supported && supported.length > 0 ? supported : COMMON_ZONES;
  const current = schedule.value?.timeZone;
  return current && !list.includes(current) ? [current, ...list] : list;
});

function sameSchedule(a: ScheduleSettings, b: ScheduleSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.collectTime === b.collectTime &&
    a.timeZone === b.timeZone &&
    a.autoGenerate === b.autoGenerate &&
    a.publish === b.publish
  );
}

const dirty = computed(
  () =>
    Boolean(schedule.value) &&
    Boolean(settingsData.value) &&
    !sameSchedule(schedule.value!, settingsData.value!.schedule),
);

watch(
  () => settingsData.value,
  (value) => {
    if (value) schedule.value = { ...value.schedule };
  },
  { immediate: true },
);

function describe(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : '操作失败，请稍后重试。';
}

async function saveSchedule(): Promise<void> {
  if (!schedule.value || saving.value) return;
  saving.value = true;
  jobNotice.value = '';
  jobError.value = '';
  try {
    const updated = await api.updateSettings(schedule.value);
    settingsData.value = updated;
    schedule.value = { ...updated.schedule };
    jobNotice.value = '定时设置已保存，下一轮按新时刻计算。';
    await loadStatus();
  } catch (cause) {
    jobError.value = describe(cause);
  } finally {
    saving.value = false;
  }
}

async function runNow(): Promise<void> {
  if (running.value || !schedule.value) return;
  running.value = true;
  jobNotice.value = '';
  jobError.value = '';
  try {
    const run = await api.runJob({
      generate: schedule.value.autoGenerate,
      publish: schedule.value.publish,
    });
    const label = runStatusLabel(run.status);
    if (run.status === 'failed') {
      jobError.value = `运行失败：${run.detail.note ?? '请查看日志。'}`;
    } else {
      const note = run.detail.note?.trim() ?? '';
      const stop = note && !/[。！？.!?]$/.test(note) ? '。' : '';
      jobNotice.value = `运行${label}。${note}${stop}`;
      if (run.detail.issue?.issueId) {
        jobNotice.value += ` 期刊 #${run.detail.issue.issueId} 可以在档案里打开。`;
      }
    }
    await loadStatus();
    await loadBackups();
  } catch (cause) {
    jobError.value = describe(cause);
  } finally {
    running.value = false;
  }
}

const runStatusLabel = (status: JobRunSummary['status']): string =>
  status === 'ok'
    ? '完成'
    : status === 'partial'
      ? '部分完成'
      : status === 'skipped'
        ? '跳过'
        : status === 'failed'
          ? '失败'
          : '进行中';

function localize(iso: string | null | undefined, zone: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

const nextRunText = computed(() => {
  if (!statusData.value) return '读取中…';
  const next = statusData.value.status.nextRunAt;
  if (!next) return schedule.value?.enabled ? '等下一轮计算' : '定时任务已停用';
  const due = new Date(next).getTime() <= Date.now();
  return due ? '已到点，等待本轮开始' : localize(next, timeZone.value);
});

const recentRuns = computed(() => statusData.value?.status.recentRuns.slice(0, 5) ?? []);

// ── 补一期 ──────────────────────────────────────────────
const catchDate = ref('');
const catchPreview = ref<IssuePreview | null>(null);
const catchLoading = ref(false);
const catchSaving = ref(false);
const catchError = ref('');
const catchNotice = ref('');
const catchIssueId = ref<number | null>(null);

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

watch(
  () => statusData.value,
  (value) => {
    if (value && !catchDate.value) catchDate.value = shiftDate(value.status.localDate, -1);
  },
  { immediate: true },
);

watch(catchDate, () => {
  catchPreview.value = null;
  catchError.value = '';
  catchNotice.value = '';
  catchIssueId.value = null;
});

const emptyReasons: Record<string, string> = {
  no_recent: '这个日期前后没有采集到新文章。',
  all_used: '这个时间窗口里的文章都已经编进过往期了。',
  filters: '有文章，但都被栏目的来源或时间筛选排除了。',
};

const catchSections = computed(
  () => catchPreview.value?.sections.filter((section) => section.articles.length > 0) ?? [],
);

async function previewCatchup(): Promise<void> {
  if (!catchDate.value || catchLoading.value) return;
  catchLoading.value = true;
  catchError.value = '';
  catchNotice.value = '';
  catchIssueId.value = null;
  try {
    catchPreview.value = await api.previewIssue({ date: catchDate.value });
  } catch (cause) {
    catchError.value = describe(cause);
  } finally {
    catchLoading.value = false;
  }
}

async function saveCatchup(publish: boolean): Promise<void> {
  if (!catchPreview.value || catchSaving.value) return;
  catchSaving.value = true;
  catchError.value = '';
  catchNotice.value = '';
  try {
    const result = await api.generateIssue({
      date: catchPreview.value.issueDate,
      publish,
      replaceDraft: Boolean(catchPreview.value.existingIssue),
    });
    if (!result.generated) {
      catchError.value =
        emptyReasons[result.reason ?? 'no_recent'] ?? '没有可编的内容，没有生成空刊。';
      catchPreview.value = result.preview;
      return;
    }
    catchIssueId.value = result.issue!.id;
    catchNotice.value = publish
      ? `已补出并出版 ${catchPreview.value.issueDate} 的一期，共 ${result.issue!.stats.total} 篇。`
      : `已把 ${catchPreview.value.issueDate} 存成预览稿，共 ${result.issue!.stats.total} 篇。确认后可以在档案里发布。`;
    catchPreview.value = null;
    await loadStatus();
  } catch (cause) {
    catchError.value = describe(cause);
  } finally {
    catchSaving.value = false;
  }
}

// ── 备份 ──────────────────────────────────────────────
const backupNotice = ref('');
const backupFailure = ref('');

const recentBackups = computed(() => backupData.value?.items.slice(0, 5) ?? []);

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

async function backupNow(): Promise<void> {
  if (backingUp.value) return;
  backingUp.value = true;
  backupNotice.value = '';
  backupFailure.value = '';
  try {
    const backup = await api.createBackup();
    backupNotice.value = `已生成 ${backup.file}（${formatBytes(backup.bytes)}）。`;
    await loadBackups();
  } catch (cause) {
    backupFailure.value = describe(cause);
  } finally {
    backingUp.value = false;
  }
}

const planned = [
  { title: 'AI 摘要（可选）', detail: 'Phase 5：未配置时核心功能照常工作；摘要在页面上始终标注为系统生成。' },
  { title: '数据清理与日志', detail: '保留策略、日志查看和版本信息，后续再补。' },
];

onMounted(async () => {
  await Promise.all([loadSettings(), loadStatus(), loadBackups()]);
});
</script>

<template>
  <div class="page">
    <header class="page-head">
      <p class="page-head__kicker">SETTINGS · 全局规则</p>
      <h1 class="page-head__title">设置</h1>
      <p class="page-head__hint">
        定时任务在服务进程内运行，配置存在本机数据库里；重启后接着生效，同一天不会重复生成一期。
      </p>
    </header>

    <p v-if="jobNotice" class="notice notice--wide" role="status">{{ jobNotice }}</p>
    <p v-if="jobError" class="notice notice--wide notice--error" role="alert">{{ jobError }}</p>

    <StateBlock v-if="settingsLoading && !schedule" variant="loading" />
    <StateBlock
      v-else-if="settingsError && !schedule"
      variant="error"
      mark="设置"
      title="设置没能取回来"
      :hint="settingsError"
      @retry="loadSettings"
    />

    <template v-else-if="schedule">
      <section aria-labelledby="settings-schedule">
        <div class="section__head">
          <h2 id="settings-schedule" class="section__name">定时采集与出报</h2>
          <span class="section__page">应用内调度器</span>
        </div>

        <form class="settings-form" @submit.prevent="saveSchedule">
          <label class="toggle">
            <input v-model="schedule.enabled" type="checkbox" :disabled="saving" />
            <span>
              <strong>启用每日定时任务</strong>
              <span class="toggle__hint">
                到点自动采集所有启用的来源。服务在别的时点启动时，如果今天还没跑过，会补跑一次。
              </span>
            </span>
          </label>

          <div class="settings-row">
            <label class="field">
              <span class="field__label">每天几点开始</span>
              <input
                v-model="schedule.collectTime"
                class="field__input"
                type="time"
                step="60"
                :disabled="saving || !schedule.enabled"
                required
              />
            </label>
            <label class="field">
              <span class="field__label">时区（IANA 名称）</span>
              <input
                v-model.trim="schedule.timeZone"
                class="field__input"
                type="text"
                list="settings-timezones"
                spellcheck="false"
                autocomplete="off"
                :disabled="saving"
                required
              />
              <datalist id="settings-timezones">
                <option v-for="zone in timeZones" :key="zone" :value="zone" />
              </datalist>
            </label>
          </div>

          <label class="toggle">
            <input
              v-model="schedule.autoGenerate"
              type="checkbox"
              :disabled="saving || !schedule.enabled"
            />
            <span>
              <strong>采集完成后自动编排一期</strong>
              <span class="toggle__hint">
                按默认模板选稿。当天已有预览稿或已出版时不会覆盖，只会记录“跳过生成”。
              </span>
            </span>
          </label>

          <label class="toggle">
            <input
              v-model="schedule.publish"
              type="checkbox"
              :disabled="saving || !schedule.enabled || !schedule.autoGenerate"
            />
            <span>
              <strong>生成后直接出版</strong>
              <span class="toggle__hint">
                关着的时候只存预览稿，确认版面后再发布。已出版的当天不能再改。
              </span>
            </span>
          </label>

          <div class="btn-row">
            <button class="btn btn--primary" type="submit" :disabled="saving || !dirty">
              {{ saving ? '正在保存…' : dirty ? '保存设置' : '已保存' }}
            </button>
            <button
              class="btn"
              type="button"
              :disabled="running"
              @click="runNow"
            >
              {{ running ? '正在运行…' : '立即运行一次' }}
            </button>
            <span class="settings-hint">
              立即运行与定时任务共用同一把锁；已有任务在跑时会直接拒绝。
            </span>
          </div>
        </form>

        <dl class="facts">
          <div>
            <dt>调度器</dt>
            <dd>
              <span
                class="status"
                :class="statusData?.status.running ? 'status--ok' : ''"
              >
                <span class="status__dot" aria-hidden="true"></span>
                {{ !statusData ? '读取中…' : statusData.status.running ? '运行中' : '未启动' }}
              </span>
            </dd>
          </div>
          <div>
            <dt>下次运行</dt>
            <dd>{{ nextRunText }}</dd>
          </div>
          <div>
            <dt>现在</dt>
            <dd>{{ statusData?.status.localDate }} {{ statusData?.status.localTime }}</dd>
          </div>
          <div>
            <dt>上次运行</dt>
            <dd>
              <template v-if="statusData?.status.lastRun">
                {{ localize(statusData.status.lastRun.startedAt, timeZone) }} ·
                {{ runStatusLabel(statusData.status.lastRun.status) }}
              </template>
              <template v-else>还没有运行记录</template>
            </dd>
          </div>
        </dl>

        <p class="settings-hint">
          采集时刻和“今天”都按上面的时区计算（当前 {{ timeZone }}），不用管浏览器所在的时区。
        </p>
      </section>

      <section aria-labelledby="settings-runs" class="section-gap">
        <div class="section__head">
          <h2 id="settings-runs" class="section__name">最近的任务</h2>
          <span class="section__page">只保留在本机数据库</span>
        </div>

        <p v-if="recentRuns.length === 0" class="settings-hint">还没有运行记录。</p>
        <ol v-else class="runs">
          <li v-for="run in recentRuns" :key="run.id" class="run">
            <div class="run__head">
              <span class="run__when">{{ localize(run.startedAt, timeZone) }}</span>
              <span class="run__trigger">{{ run.trigger === 'schedule' ? '定时' : '手动' }}</span>
              <span class="run__status" :class="`run__status--${run.status}`">
                {{ runStatusLabel(run.status) }}
              </span>
            </div>
            <p class="run__note">{{ run.detail.note ?? '没有记录备注。' }}</p>
            <p v-if="run.detail.sources" class="run__meta">
              来源 {{ run.detail.sources.total }} 个 · 成功 {{ run.detail.sources.ok }} ·
              失败 {{ run.detail.sources.failed }} · 新增 {{ run.detail.sources.inserted }} 篇
            </p>
          </li>
        </ol>
      </section>

      <section aria-labelledby="settings-catchup" class="section-gap">
        <div class="section__head">
          <h2 id="settings-catchup" class="section__name">补一期</h2>
          <span class="section__page">先预览，再写入</span>
        </div>
        <p class="settings-hint">
          给漏掉的日期补一份报纸。选稿只取那个时间窗口里还没被任何一期用过的文章；已出版的日期不会被覆盖。
        </p>

        <form class="catchup" @submit.prevent="previewCatchup">
          <label class="field catchup__date">
            <span class="field__label">补哪一天</span>
            <input
              v-model="catchDate"
              class="field__input"
              type="date"
              :max="statusData?.status.localDate"
              :disabled="catchLoading || catchSaving"
              required
            />
          </label>
          <button class="btn" type="submit" :disabled="catchLoading || catchSaving || !catchDate">
            {{ catchLoading ? '正在编排…' : '预览这一期' }}
          </button>
        </form>

        <p v-if="catchError" class="error-text" role="alert">{{ catchError }}</p>
        <p v-if="catchNotice" class="ok-text" role="status">
          {{ catchNotice }}
          <RouterLink v-if="catchIssueId" :to="`/issue/${catchIssueId}`">打开这一期</RouterLink>
        </p>

        <div v-if="catchPreview" class="proof">
          <div class="proof__head">
            <div>
              <p class="proof__kicker">CATCH-UP PREVIEW · 尚未写入</p>
              <h3 class="proof__title">{{ catchPreview.issueDate }} · {{ catchPreview.templateName }}</h3>
            </div>
            <span class="proof__count">{{ catchPreview.total }} / {{ catchPreview.maxTotalArticles }} 篇</span>
          </div>

          <p v-if="catchPreview.existingIssue" class="notice">
            <template v-if="catchPreview.existingIssue.status === 'published'">
              <strong>这一天已经出版。</strong> 已出版的版面不会被覆盖。
            </template>
            <template v-else>
              <strong>这一天已有一份预览稿。</strong> 保存会重新编排并替换它。
            </template>
          </p>

          <p v-if="catchPreview.total === 0" class="proof__empty">
            {{ emptyReasons[catchPreview.emptyReason ?? 'no_recent'] ?? '没有可编的内容。' }}
          </p>
          <ul v-else class="proof__sections">
            <li v-for="section in catchSections" :key="section.sectionId ?? section.name">
              <strong>{{ section.name }}</strong>
              <span>{{ section.articles.length }} 篇</span>
              <span v-if="section.omitted > 0"> · {{ section.omitted }} 篇留在文章库</span>
            </li>
          </ul>

          <div
            v-if="catchPreview.total > 0 && catchPreview.existingIssue?.status !== 'published'"
            class="btn-row"
          >
            <button class="btn btn--primary" type="button" :disabled="catchSaving" @click="saveCatchup(false)">
              {{ catchPreview.existingIssue ? '替换为预览稿' : '存为预览稿' }}
            </button>
            <button class="btn" type="button" :disabled="catchSaving" @click="saveCatchup(true)">
              {{ catchPreview.existingIssue ? '替换并出版' : '保存并出版' }}
            </button>
          </div>
        </div>
      </section>

      <section aria-labelledby="settings-backup" class="section-gap">
        <div class="section__head">
          <h2 id="settings-backup" class="section__name">备份与恢复</h2>
          <span class="section__page">单文件数据库</span>
        </div>
        <p class="settings-hint">
          SQLite 是单文件数据库。这里生成的是在线副本，不用停服务；升级数据库前也会自动留一份。
          恢复时先停服务，再把备份文件复制成 <code>data/newspaper.db</code>，并移除同目录的
          <code>.db-wal</code> / <code>.db-shm</code>。
        </p>

        <p v-if="backupError" class="error-text" role="alert">{{ backupError }}</p>
        <p v-if="backupFailure" class="error-text" role="alert">{{ backupFailure }}</p>
        <p v-if="backupNotice" class="ok-text" role="status">{{ backupNotice }}</p>

        <div class="btn-row">
          <button class="btn" type="button" :disabled="backingUp" @click="backupNow">
            {{ backingUp ? '正在备份…' : '立即备份' }}
          </button>
          <span v-if="backupData" class="settings-hint">
            目录：<code>{{ backupData.dir }}</code>
          </span>
        </div>

        <ul v-if="recentBackups.length > 0" class="backups">
          <li v-for="backup in recentBackups" :key="backup.file" class="backup">
            <span class="backup__file">{{ backup.file }}</span>
            <span class="backup__meta">
              {{ backup.kind === 'pre-migration' ? '升级前自动' : '手动' }} ·
              {{ formatBytes(backup.bytes) }} · {{ formatDateTime(backup.createdAt) }}
            </span>
          </li>
        </ul>
        <p v-else class="settings-hint">还没有备份文件。</p>
      </section>

      <section aria-labelledby="settings-template" class="section-gap">
        <div class="section__head">
          <h2 id="settings-template" class="section__name">版面与容量</h2>
          <span class="section__page">在模板编辑器里</span>
        </div>
        <p class="settings-hint">
          每期容量、栏目与选稿范围、默认模板都归模板编辑器管。生成一期在今日报纸完成，先看编排预览，再决定保存为预览稿还是直接出版。
        </p>
        <div class="btn-row">
          <RouterLink to="/templates" class="btn">打开模板编辑器</RouterLink>
          <RouterLink to="/" class="btn btn--quiet">去生成一期</RouterLink>
          <RouterLink to="/archive" class="btn btn--quiet">查看期刊档案</RouterLink>
        </div>
      </section>

      <section aria-labelledby="settings-planned" class="section-gap">
        <div class="section__head">
          <h2 id="settings-planned" class="section__name">还没做出来的设置</h2>
          <span class="section__page">按 Phase 顺序</span>
        </div>
        <dl class="planned">
          <div v-for="item in planned" :key="item.title" class="planned__item">
            <dt>{{ item.title }}</dt>
            <dd>{{ item.detail }}</dd>
          </div>
        </dl>
      </section>
    </template>

    <div class="notice notice--wide" style="margin-top: clamp(28px, 4vw, 44px)">
      <strong>这台机器就是全部服务器。</strong>
      服务默认只监听 127.0.0.1，数据库文件在 <code>data/newspaper.db</code>，备份默认放在
      <code>data/backups/</code>。
    </div>
  </div>
</template>

<style scoped>
.section-gap {
  margin-top: clamp(28px, 4vw, 44px);
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  border-top: var(--hairline);
  padding-top: 18px;
}

.settings-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.toggle {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  cursor: pointer;
}

.toggle input {
  margin-top: 4px;
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  flex-shrink: 0;
}

.toggle strong {
  display: block;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.toggle__hint {
  display: block;
  margin-top: 3px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink-muted);
}

.settings-hint {
  font-family: var(--sans);
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--ink-faint);
  margin: 0;
}

.settings-hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  padding: 1px 4px;
  border: 1px solid var(--rule);
  background: var(--paper-raise);
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px 24px;
  margin: 20px 0 0;
  padding: 14px 0;
  border-top: var(--hairline);
  border-bottom: var(--hairline);
}

.facts dt {
  font-family: var(--sans);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--ink-faint);
}

.facts dd {
  margin: 4px 0 0;
  font-size: 14px;
  line-height: 1.6;
}

.runs {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: var(--hairline);
}

.run {
  padding: 12px 2px;
  border-bottom: var(--hairline);
}

.run__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
}

.run__when {
  font-size: 14px;
}

.run__trigger,
.run__status {
  font-family: var(--sans);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  color: var(--ink-faint);
}

.run__status {
  margin-left: auto;
}

.run__status--failed {
  color: var(--accent);
}

.run__status--partial {
  color: var(--accent);
}

.run__note {
  margin: 4px 0 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink-muted);
}

.run__meta {
  margin: 3px 0 0;
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink-faint);
}

.catchup {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin: 14px 0;
}

.catchup__date {
  max-width: 220px;
  flex: 1 1 180px;
}

.proof {
  border: 1px solid var(--ink);
  background: var(--paper-raise);
  padding: 16px 18px;
  margin-top: 14px;
}

.proof__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: var(--hairline);
}

.proof__kicker {
  font-family: var(--sans);
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--ink-faint);
}

.proof__title {
  margin-top: 4px;
  font-family: var(--serif);
  font-size: 18px;
  letter-spacing: 0.03em;
}

.proof__count {
  font-family: var(--sans);
  font-size: 11.5px;
  color: var(--ink-muted);
  white-space: nowrap;
}

.proof .notice {
  max-width: none;
  margin: 12px 0 0;
}

.proof__empty {
  margin: 12px 0 0;
  font-size: 13.5px;
  color: var(--ink-muted);
}

.proof__sections {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.proof__sections li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
  font-size: 13.5px;
  color: var(--ink-muted);
}

.proof__sections strong {
  color: var(--ink);
}

.backups {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  border-top: var(--hairline);
}

.backup {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  align-items: baseline;
  padding: 9px 2px;
  border-bottom: var(--hairline);
}

.backup__file {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.backup__meta {
  margin-left: auto;
  font-family: var(--sans);
  font-size: 11px;
  color: var(--ink-faint);
}

.planned {
  display: grid;
  gap: 0;
  margin: 0;
  border-top: var(--hairline);
}

.planned__item {
  display: grid;
  grid-template-columns: 12em minmax(0, 1fr);
  gap: 16px;
  padding: 14px 4px;
  border-bottom: var(--hairline);
}

.planned__item dt {
  font-size: 15px;
  color: var(--ink);
}

.planned__item dd {
  margin: 0;
  font-size: 14px;
  line-height: 1.75;
  color: var(--ink-muted);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  padding: 1px 4px;
  border: 1px solid var(--rule);
  background: var(--paper-raise);
}

@media (max-width: 720px) {
  .planned__item {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }

  .backup__meta {
    margin-left: 0;
  }

  .run__status {
    margin-left: 0;
  }
}
</style>
