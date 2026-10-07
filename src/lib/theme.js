import { esc } from './html.js';

const STORAGE_KEY = 'autexa-theme';
const ORDER = ['system', 'light', 'dark'];
const ICONS = { system: '◐', light: '☀', dark: '☾' };
const media = window.matchMedia('(prefers-color-scheme: dark)');

export const themePreference = () => (ORDER.includes(localStorage.getItem(STORAGE_KEY)) ? localStorage.getItem(STORAGE_KEY) : 'system');
export const themeIcon = (preference = themePreference()) => ICONS[preference];

export function applyTheme() {
  const preference = themePreference();
  const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#080b12' : '#f5f6fa');
}

export function cycleTheme() {
  const next = ORDER[(ORDER.indexOf(themePreference()) + 1) % ORDER.length];
  localStorage.setItem(STORAGE_KEY, next);
  applyTheme();
  return next;
}

export function initTheme() {
  applyTheme();
  media.addEventListener('change', () => { if (themePreference() === 'system') applyTheme(); });
}

export function themeButton(t, id = 'theme-toggle', extraClass = '') {
  const preference = themePreference();
  const label = esc(`${t.theme}: ${t[`theme_${preference}`]}`);
  return `<button class="language ${extraClass}" id="${id}" type="button" title="${label}" aria-label="${label}">${ICONS[preference]}</button>`;
}

export function wireThemeButton(button, t) {
  button?.addEventListener('click', () => {
    const next = cycleTheme();
    const label = `${t.theme}: ${t[`theme_${next}`]}`;
    button.textContent = ICONS[next];
    button.title = label;
    button.setAttribute('aria-label', label);
  });
}
