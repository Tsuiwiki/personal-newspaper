import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import PublishedPaper from './PublishedPaper.vue';
import './styles/tokens.css';
import './styles/paper.css';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'paper', component: PublishedPaper },
    { path: '/issue/:id', name: 'issue', component: PublishedPaper },
    { path: '/article/:id', name: 'article', component: PublishedPaper },
    { path: '/archive', name: 'archive', component: PublishedPaper },
    { path: '/:pathMatch(.*)*', name: 'missing', component: PublishedPaper },
  ],
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
});

createApp(PublishedPaper).use(router).mount('#app');
