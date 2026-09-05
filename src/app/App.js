import { appShell, wireShell } from '../components/layout/AppShell.js';
import { copy } from '../i18n/translations.js';
import { overview, loadBookings, loadDashboardSummary } from '../features/dashboard/Overview.js';

const state = { locale: localStorage.getItem('autexa-locale') || (navigator.language.startsWith('ar') ? 'ar' : 'en'), route: 'overview' };

export function createApp(root) {
  const render = () => {
    const t = copy[state.locale];
    document.documentElement.lang = state.locale;
    document.documentElement.dir = state.locale === 'ar' ? 'rtl' : 'ltr';
    const content = state.route === 'overview' ? overview(t) : emptyState(t, state.route);
    root.innerHTML = appShell({ locale: t, active: state.route, content, isArabic: state.locale === 'ar' });
    wireShell(root, {
      navigate: (route) => { state.route = route; render(); },
      locale: () => { state.locale = state.locale === 'en' ? 'ar' : 'en'; localStorage.setItem('autexa-locale', state.locale); render(); },
      create: () => toast(state.locale === 'ar' ? 'نافذة الإنشاء جاهزة للخطوة التالية.' : 'Create flow ready for the next step.'),
    });
    root.querySelector('.search input')?.addEventListener('input', (event) => { if (event.target.value.length > 2) toast(`${event.target.value}: ${state.locale === 'ar' ? 'سيتم البحث هنا' : 'search will appear here'}`); });
    if (state.route === 'overview') {
      loadBookings(root, t);
      loadDashboardSummary(root);
    }
  };
  render();
}

function emptyState(t, route) {
  return `<div class="empty-state"><div class="empty-orb">✦</div><h1>${t[route]}</h1><h2>${t.emptyTitle}</h2><p>${t.emptyText}</p><button class="create" onclick="document.querySelector('#create-button').click()">＋ ${t.create}</button></div>`;
}

function toast(message) {
  const toastElement = document.querySelector('#toast');
  if (!toastElement) return;
  toastElement.textContent = message;
  toastElement.classList.add('visible');
  window.setTimeout(() => toastElement.classList.remove('visible'), 2500);
}
