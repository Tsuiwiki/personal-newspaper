<script setup lang="ts">
import { computed } from 'vue';
import { relativeTime } from '../utils/format';

const props = defineProps<{
  sourceName: string | null;
  publishedAt: string | null;
  accessLevel: string;
}>();

const sourceLabel = computed(() => props.sourceName ?? '手动添加');
const linkOnly = computed(() => props.accessLevel === 'link_only');
</script>

<template>
  <p class="kicker">
    <span class="kicker__source">{{ sourceLabel }}</span>
    <span class="kicker__dot" aria-hidden="true">·</span>
    <span>{{ relativeTime(publishedAt) }}</span>
    <span v-if="linkOnly" class="kicker__dot" aria-hidden="true">·</span>
    <span v-if="linkOnly">仅链接</span>
  </p>
</template>
