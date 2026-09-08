import { appShell, wireShell } from '../components/layout/AppShell.js';
import { copy } from '../i18n/translations.js';
import { overview, loadBookings, loadDashboardSummary } from '../features/dashboard/Overview.js';
import { conversationsPage, loadConversations } from '../features/conversations/Conversations.js';
import { customersPage, loadCustomers } from '../features/customers/Customers.js';
import { knowledgeBasePage, loadKnowledgeBase } from '../features/knowledge-base/KnowledgeBase.js';
import { analyticsPage, loadAnalytics } from '../features/analytics/Analytics.js';

const state = { locale: localStorage.getItem('autexa-locale') || (navigator.language.startsWith('ar') ? 'ar' : 'en'), route: 'overview' };

export function createApp(root) {
  const handlers = {
    navigate: (route) => { state.route = route; render(); },
    locale: () => { state.locale = state.locale === 'en' ? 'ar' : 'en'; localStorage.setItem('autexa-locale', state.locale); render(); },
    create: () => toast(state.locale === 'ar' ? 'نافذة الإنشاء جاهزة للخطوة التالية.' : 'Create flow ready for the next step.'),
    openConversation: (id) => toast(`${state.locale === 'ar' ? 'فتح محادثة' : 'Open conversation'} ${id.slice(0, 8)}…`),
    openCustomer: (id) => toast(`${state.locale === 'ar' ? 'فتح عميل' : 'Open customer'} ${id.slice(0, 8)}…`),
    openArticle: (id) => toast(`${state.locale === 'ar' ? 'فتح مقالة' : 'Open article'} ${id.slice(0, 8)}…`),
  };

  const render = () => {
    const t = copy[state.locale];
    document.documentElement.lang = state.locale;
    document.documentElement.dir = state.locale === 'ar' ? 'rtl' : 'ltr';
    const content = buildContent(t, state.route, handlers);
    root.innerHTML = appShell({ locale: t, active: state.route, content, isArabic: state.locale === 'ar' });
    wireShell(root, handlers);
    root.querySelector('.search input')?.addEventListener('input', (event) => { if (event.target.value.length > 2) toast(`${event.target.value}: ${state.locale === 'ar' ? 'سيتم البحث هنا' : 'search will appear here'}`); });
    loadRouteData(root, t, state.route, handlers);
  };
  render();
}

function buildContent(t, route) {
  switch (route) {
    case 'overview': return overview(t);
    case 'conversations': return conversationsPage(t);
    case 'customers': return customersPage(t);
    case 'knowledge': return knowledgeBasePage(t);
    case 'analytics': return analyticsPage(t);
    default: return emptyState(t, route);
  }
}

function loadRouteData(root, t, route, handlers) {
  switch (route) {
    case 'overview':
      loadBookings(root, t);
      loadDashboardSummary(root);
      break;
    case 'conversations':
      loadConversations(root, t, handlers);
      break;
    case 'customers':
      loadCustomers(root, t, handlers);
      break;
    case 'knowledge':
      loadKnowledgeBase(root, t, handlers);
      break;
    case 'analytics':
      loadAnalytics(root, t);
      break;
    default:
      break;
  }
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
