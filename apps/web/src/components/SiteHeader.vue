<script setup lang="ts">
import { RouterLink } from 'vue-router';

const links = [
  { to: '/', label: '今日报纸' },
  { to: '/archive', label: '期刊档案' },
  { to: '/library', label: '文章库' },
  { to: '/sources', label: '信息来源' },
  { to: '/templates', label: '模板编辑器' },
  { to: '/settings', label: '设置' },
];
</script>

<template>
  <header class="site-header">
    <div class="site-header__inner">
      <RouterLink to="/" class="brand" aria-label="纸间 · 回到今日报纸">
        <span class="brand__mark">纸间</span>
        <span class="brand__sub">PERSONAL DAILY</span>
      </RouterLink>
      <nav class="nav" aria-label="主导航">
        <RouterLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="nav__link"
          active-class=""
          exact-active-class="nav__link--active"
        >
          {{ link.label }}
        </RouterLink>
      </nav>
    </div>
  </header>
</template>
