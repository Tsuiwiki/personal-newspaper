import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'today', component: () => import('./pages/TodayPaper.vue'), meta: { title: '今日报纸' } },
  { path: '/issue/:id', name: 'issue', component: () => import('./pages/IssuePage.vue'), meta: { title: '期刊' } },
  {
    path: '/article/:id',
    name: 'article',
    component: () => import('./pages/ArticlePage.vue'),
    meta: { title: '文章' },
  },
  { path: '/archive', name: 'archive', component: () => import('./pages/ArchivePage.vue'), meta: { title: '期刊档案' } },
  { path: '/library', name: 'library', component: () => import('./pages/LibraryPage.vue'), meta: { title: '文章库' } },
  { path: '/sources', name: 'sources', component: () => import('./pages/SourcesPage.vue'), meta: { title: '信息来源' } },
  {
    path: '/templates',
    name: 'templates',
    component: () => import('./pages/TemplatesPage.vue'),
    meta: { title: '模板编辑器' },
  },
  { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue'), meta: { title: '设置' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./pages/NotFoundPage.vue'), meta: { title: '找不到页面' } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (_to, _from, savedPosition) => savedPosition ?? { top: 0 },
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '个人数字报纸';
  document.title = `${title} · 纸间`;
});
