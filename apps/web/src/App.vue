<script setup lang="ts">
import { RouterView } from 'vue-router';
import SiteHeader from './components/SiteHeader.vue';
import SiteFooter from './components/SiteFooter.vue';
</script>

<template>
  <a class="skip-link" href="#main">跳到正文</a>
  <div class="shell">
    <SiteHeader />
    <main id="main" class="main" tabindex="-1">
      <RouterView />
    </main>
    <SiteFooter />
  </div>
</template>
