<script setup lang="ts">
import { RouterLink } from 'vue-router';
</script>

<template>
  <div class="page">
    <div class="state">
      <p class="state__mark">404</p>
      <p class="state__title">这一版没有这条内容</p>
      <p class="state__hint">链接可能已经失效，或者地址打错了。报纸本身还在。</p>
      <div class="state__actions">
        <RouterLink to="/" class="btn btn--primary">回到今日报纸</RouterLink>
        <RouterLink to="/archive" class="btn btn--quiet">翻期刊档案</RouterLink>
      </div>
    </div>
  </div>
</template>
