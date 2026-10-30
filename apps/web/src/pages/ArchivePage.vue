<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api/client';
import { useAsync } from '../composables/useAsync';
import { formatIssueDate } from '../utils/format';
import StateBlock from '../components/StateBlock.vue';

const { data, loading, error, load } = useAsync(() => api.issues());
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <p class="page-head__kicker">ARCHIVE · 按期回看</p>
      <h1 class="page-head__title">期刊档案</h1>
      <p class="page-head__hint">
        每一期都保留生成当时的文章顺序、栏目分配和模板快照。之后修改模板，不会改动已经出过的报纸。
      </p>
    </header>

    <StateBlock v-if="loading" variant="loading" />

    <StateBlock
      v-else-if="error"
      variant="error"
      mark="档案"
      title="档案没能取回来"
      :hint="error"
      @retry="load"
    />

    <StateBlock
      v-else-if="!data || data.items.length === 0"
      variant="empty"
      mark="档案"
      title="还没有存档的期刊"
      hint="生成第一期之后，这里会按日期一期一期排下去。"
    >
      <template #actions>
        <RouterLink to="/" class="btn btn--quiet">回到今日报纸</RouterLink>
      </template>
    </StateBlock>

    <template v-else>
      <div class="archive__head" aria-hidden="true">
        <span>日期</span>
        <span>期刊</span>
        <span>篇数</span>
        <span>状态</span>
      </div>
      <div class="archive">
        <RouterLink
          v-for="item in data.items"
          :key="item.id"
          :to="`/issue/${item.id}`"
          class="archive__row"
        >
          <span class="archive__date">{{ formatIssueDate(item.issueDate, 'M月D日 dddd') }}</span>
          <span class="archive__title">第 {{ item.issueNumber }} 期 · {{ item.mastheadTitle }}</span>
          <span class="archive__meta archive__meta--articles">{{ item.articleCount }} 篇</span>
          <span class="archive__meta">
            {{ item.status === 'published' ? '已出版' : item.status === 'draft' ? '预览稿' : '失败' }}
          </span>
        </RouterLink>
      </div>

      <p class="masthead__quiet" style="margin-top: 16px">
        共 {{ data.items.length }} 期 · 档案暂不分页，更早的期刊会一直往下排
      </p>
    </template>
  </div>
</template>
