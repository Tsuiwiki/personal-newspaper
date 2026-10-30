import { DEFAULT_THEME, type ThemeSettings } from '@paper/shared';

/** 模板主题作用在根元素上，保证纸张底色铺满整页而不只覆盖中间那一栏 */
export function applyTheme(theme: ThemeSettings): void {
  const root = document.documentElement.style;
  root.setProperty('--paper', theme.paper);
  root.setProperty('--ink', theme.ink);
  root.setProperty('--ink-muted', theme.inkMuted);
  root.setProperty('--rule', theme.rule);
  root.setProperty('--accent', theme.accent);
  root.setProperty('--content-width', `${theme.contentWidth}px`);
}

export function resetTheme(): void {
  applyTheme(DEFAULT_THEME);
}
