<script setup lang="ts">
import { ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    src: string | null;
    alt: string;
    credit?: string | null;
    variant?: 'lead' | 'feature' | 'thumb';
  }>(),
  { credit: null, variant: 'thumb' },
);

const failed = ref(false);
watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <figure v-if="src" class="media" :class="`media--${variant}`">
    <img v-if="!failed" :src="src" :alt="alt" loading="lazy" decoding="async" @error="failed = true" />
    <div v-else class="img-fallback" role="img" :aria-label="`${alt}：图片加载失败`">
      <span class="img-fallback__mark">图片未能显示</span>
      <span>{{ credit ? `${credit} 的图片可能已失效` : '图片链接可能已失效' }}，不影响阅读</span>
    </div>
  </figure>
</template>
