<script setup lang="ts">
import { computed, onUnmounted, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api } from '../api/client';
import { useAsync } from '../composables/useAsync';
import { applyTheme, resetTheme } from '../utils/theme';
import PaperMasthead from '../components/PaperMasthead.vue';
import SectionBlock from '../components/SectionBlock.vue';
import StateBlock from '../components/StateBlock.vue';

const route = useRoute();
const issueId = computed(() => Number(route.params.id));
const { data: issue, loading, error, load } = useAsync(() => api.issue(issueId.value));

watch(issueId, () => load(), { immediate: true });

watch(
  issue,
  (value) => {
    if (value) applyTheme(value.theme);
  },
  { immediate: true },
);

onUnmounted(resetTheme);
</script>

<template>
  <div class="page">
    <StateBlock v-if="loading" variant="loading" />

    <StateBlock
      v-else-if="error"
      variant="error"
      mark="期刊档案"
      title="这一期打不开"
      :hint="error"
      @retry="load"
    >
      <template #actions>
        <RouterLink to="/archive" class="btn">回到档案</RouterLink>
      </template>
    </StateBlock>

    <template v-else-if="issue">
      <div class="page-head page-head--flat" style="border-bottom: 0; padding-bottom: 0">
        <RouterLink to="/archive" class="reader__back">← 回到期刊档案</RouterLink>
        <p class="notice">
          <strong>这是 {{ issue.issueDate }} 的存档。</strong>
          版面、文章顺序和模板样式都按生成当时的快照显示，之后修改模板不会改动这一期。
        </p>
      </div>

      <PaperMasthead :issue="issue" />

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
