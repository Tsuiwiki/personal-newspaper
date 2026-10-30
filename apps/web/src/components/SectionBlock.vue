<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { IssueSectionView } from '@paper/shared';
import SafeImage from './SafeImage.vue';
import StoryKicker from './StoryKicker.vue';
import StoryMeta from './StoryMeta.vue';

const props = defineProps<{ section: IssueSectionView; index: number }>();

const headingId = computed(() => `section-${props.index}`);
const lead = computed(() => props.section.articles[0] ?? null);
const sides = computed(() => props.section.articles.slice(1));
const paddedIndex = (i: number) => String(i + 1).padStart(2, '0');
const pageNumber = (i: number) => String(i + 1);
const articleLink = (id: number) => `/article/${id}`;
</script>

<template>
  <section class="section" :aria-labelledby="headingId">
    <header class="section__head">
      <h2 :id="headingId" class="section__name">{{ section.name }}</h2>
      <span class="section__page">第 {{ pageNumber(index) }} 版</span>
      <span class="section__count">{{ section.articles.length }} 篇</span>
    </header>

    <!-- 头条 -->
    <div v-if="section.layoutType === 'headline' && lead" class="layout-headline">
      <article class="layout-headline__lead">
        <StoryKicker
          :source-name="lead.sourceName"
          :published-at="lead.publishedAt"
          :access-level="lead.accessLevel"
        />
        <h3 class="story__title layout-headline__title">
          <RouterLink :to="articleLink(lead.id)">{{ lead.title }}</RouterLink>
        </h3>
        <p v-if="lead.summary" class="layout-headline__dek">{{ lead.summary }}</p>
        <SafeImage
          v-if="lead.imageUrl"
          :src="lead.imageUrl"
          :alt="lead.title"
          :credit="lead.sourceName"
          variant="lead"
        />
        <StoryMeta :article="lead" />
      </article>

      <div class="layout-headline__sides">
        <article v-for="story in sides" :key="story.id" class="side-story">
          <StoryKicker
            :source-name="story.sourceName"
            :published-at="story.publishedAt"
            :access-level="story.accessLevel"
          />
          <h3 class="story__title side-story__title">
            <RouterLink :to="articleLink(story.id)">{{ story.title }}</RouterLink>
          </h3>
          <p v-if="story.summary" class="dek">{{ story.summary }}</p>
          <StoryMeta :article="story" />
        </article>
      </div>
    </div>

    <!-- 双栏 -->
    <div v-else-if="section.layoutType === 'double'" class="layout-double">
      <article v-for="story in section.articles" :key="story.id" class="double-story">
        <StoryKicker
          :source-name="story.sourceName"
          :published-at="story.publishedAt"
          :access-level="story.accessLevel"
        />
        <h3 class="story__title double-story__title">
          <RouterLink :to="articleLink(story.id)">{{ story.title }}</RouterLink>
        </h3>
        <p v-if="story.summary" class="dek">{{ story.summary }}</p>
        <SafeImage
          v-if="story.imageUrl"
          :src="story.imageUrl"
          :alt="story.title"
          :credit="story.sourceName"
          variant="thumb"
        />
        <StoryMeta :article="story" />
      </article>
    </div>

    <!-- 大图深读 -->
    <div v-else-if="section.layoutType === 'feature'" class="layout-feature">
      <article v-for="story in section.articles" :key="story.id" class="feature-story">
        <SafeImage
          v-if="story.imageUrl"
          :src="story.imageUrl"
          :alt="story.title"
          :credit="story.sourceName"
          variant="feature"
        />
        <div class="feature-story__text">
          <StoryKicker
            :source-name="story.sourceName"
            :published-at="story.publishedAt"
            :access-level="story.accessLevel"
          />
          <h3 class="story__title feature-story__title">
            <RouterLink :to="articleLink(story.id)">{{ story.title }}</RouterLink>
          </h3>
          <p v-if="story.summary" class="dek">{{ story.summary }}</p>
          <StoryMeta :article="story" />
        </div>
      </article>
    </div>

    <!-- 列表 -->
    <div v-else-if="section.layoutType === 'list'" class="layout-list">
      <article v-for="(story, i) in section.articles" :key="story.id" class="list-story">
        <span class="list-story__index" aria-hidden="true">{{ paddedIndex(i) }}</span>
        <h3 class="story__title list-story__title">
          <RouterLink :to="articleLink(story.id)">{{ story.title }}</RouterLink>
        </h3>
        <p v-if="story.summary" class="dek">{{ story.summary }}</p>
      </article>
    </div>

    <!-- 简讯 -->
    <div v-else class="layout-brief">
      <article v-for="story in section.articles" :key="story.id" class="brief-item">
        <h3 class="brief-item__title">
          <RouterLink :to="articleLink(story.id)">{{ story.title }}</RouterLink>
        </h3>
        <p v-if="story.summary" class="dek">{{ story.summary }}</p>
      </article>
    </div>
  </section>
</template>
