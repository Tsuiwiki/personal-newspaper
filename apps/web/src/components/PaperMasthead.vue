<script setup lang="ts">
import { computed } from 'vue';
import type { IssueView } from '@paper/shared';
import { formatIssueDate } from '../utils/format';

const props = defineProps<{ issue: IssueView }>();

const dateText = computed(() => formatIssueDate(props.issue.issueDate, props.issue.masthead.dateFormat));

const statusText = computed(() => {
  switch (props.issue.status) {
    case 'published':
      return '已出版';
    case 'draft':
      return '预览稿';
    default:
      return '生成失败';
  }
});
</script>

<template>
  <header class="masthead">
    <div class="masthead__dateline">
      <div class="masthead__dateline-group">
        <span>{{ dateText }}</span>
        <span>第 {{ issue.issueNumber }} 期</span>
        <span>{{ statusText }}</span>
      </div>
      <div class="masthead__dateline-group">
        <span>共 {{ issue.stats.total }} 篇</span>
        <span>已读 {{ issue.stats.read }}</span>
        <span>稍后 {{ issue.stats.later }}</span>
      </div>
    </div>

    <h1 class="masthead__title">{{ issue.masthead.title }}</h1>
    <p v-if="issue.masthead.subtitle" class="masthead__subtitle">{{ issue.masthead.subtitle }}</p>
    <div class="masthead__rule" aria-hidden="true"></div>
  </header>
</template>
