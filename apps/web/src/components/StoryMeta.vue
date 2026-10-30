<script setup lang="ts">
import type { ArticleCard } from '@paper/shared';

defineProps<{ article: ArticleCard }>();
</script>

<template>
  <p class="meta">
    <span v-if="article.readingStatus === 'later'" class="tag tag--later">稍后读</span>
    <span v-else-if="article.readingStatus === 'read'" class="tag tag--read">已读</span>
    <span class="visually-hidden">｜</span>
    <span v-if="article.hasFullText">约 {{ article.readMinutes }} 分钟</span>
    <span v-else>仅有摘要</span>
    <span v-if="article.author" class="meta__dot" aria-hidden="true">·</span>
    <span v-if="article.author">{{ article.author }}</span>
  </p>
</template>
