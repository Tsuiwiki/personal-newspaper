<script setup lang="ts">
withDefaults(
  defineProps<{
    variant: 'loading' | 'empty' | 'error';
    mark?: string;
    title?: string;
    hint?: string;
  }>(),
  { mark: '', title: '', hint: '' },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="variant === 'loading'" class="state" aria-busy="true" aria-live="polite">
    <p class="state__mark">正在排版</p>
    <div class="skeleton-stack">
      <div class="skeleton" style="height: 54px; max-width: 420px"></div>
      <div class="skeleton" style="height: 14px; max-width: 560px"></div>
      <div class="skeleton" style="height: 14px; max-width: 470px"></div>
    </div>
  </div>

  <div v-else class="state" role="status">
    <p v-if="mark" class="state__mark">{{ mark }}</p>
    <p class="state__title">{{ title }}</p>
    <p v-if="hint" class="state__hint">{{ hint }}</p>
    <div class="state__actions">
      <button v-if="variant === 'error'" type="button" class="btn" @click="$emit('retry')">重试</button>
      <slot name="actions" />
    </div>
  </div>
</template>
