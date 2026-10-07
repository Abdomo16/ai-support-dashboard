import { appShell, wireDropdowns } from '../components/layout/AppShell.js';
import { copy, translator } from '../i18n/translations.js';
import { routes } from './routes.js';
import { esc } from '../lib/html.js';
import { go, href, parseRoute } from '../lib/router.js';
import { setFormatLocale, timeAgo } from '../lib/format.js';
import { browserNotify, playChime } from '../lib/notify.js';
import { openModal, setUiLabels, toast, toastError } from '../lib/ui.js';
import { renderAuth, mountAuth } from '../features/auth/AuthPage.js';
import { renderCreateWorkspace, mountCreateWorkspace } from '../features/onboarding/CreateWorkspace.js';
import { consumeAuthRedirect, getSession, isConfigured, signOut, subscribe } from '../services/supabaseClient.js';
import { can, createOrganization, isImpersonating, loadWorkspace, orgId, selectOrganization, workspace } from '../services/workspace.js';
import { countPendingHandoffs, getHandoffs } from '../services/handoffs.js';
import { getUsageSummary, usageMeters } from '../services/billing.js';
import { globalSearch } from '../services/search.js';

const state = {
  locale: localStorage.getItem('autexa-locale') || (navigator.language.startsWith('ar') ? 'ar' : 'en'),
  authMode: 'signin',
  shellMounted: false,
  renderToken: 0,
  pendingCreate: null,
};

let root = null;
let pageCleanup = null;
let shellCleanups = [];

const t = () => translator(state.locale);

function applyLocale() {
  document.documentElement.lang = state.locale;
  document.documentElement.dir = state.locale === 'ar' ? 'rtl' : 'ltr';
  setFormatLocale(state.locale);
  const dictionary = t();
  setUiLabels({ cancel: dictionary.cancel, save: dictionary.save, confirm: dictionary.confirm });
}

function toggleLocale() {
  state.locale = state.locale === 'en' ? 'ar' : 'en';
  localStorage.setItem('autexa-locale', state.locale);
  applyLocale();
  boot();
}

export async function createApp(element) {
  root = element;
  applyLocale();
  if (!isConfigured()) {
    root.innerHTML = `<div class="auth-screen"><div class="auth-card"><h1>${esc(t().configMissingTitle)}</h1><p class="muted-text">${esc(t().configMissingText)}</p></div></div>`;
    return;
  }
  try { await consumeAuthRedirect(); } catch (error) { toastError(error); }
  window.addEventListener('hashchange', () => {
    if (state.shellMounted) renderRoute();
    else if (parseRoute().route === 'reset-password' && getSession()) showAuth('reset-password');
  });
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      root.querySelector('#global-search input')?.focus();
    }
  });
  await boot();
}

function teardown() {
  pageCleanup?.();
  pageCleanup = null;
  shellCleanups.forEach((cleanup) => cleanup());
  shellCleanups = [];
  state.shellMounted = false;
}

async function boot() {
  teardown();
  const route = parseRoute().route;
  if (!getSession()) return showAuth(state.authMode);
  if (route === 'reset-password') return showAuth('reset-password');
  root.innerHTML = `<div class="boot-screen"><span class="brand-mark">A</span></div>`;
  try {
    await loadWorkspace();
  } catch (error) {
    if (error.status === 401 || error.status === 403) { await signOut(); return showAuth('signin'); }
    root.innerHTML = `<div class="auth-screen"><div class="auth-card"><h1>${esc(t().dataUnavailable)}</h1><p class="form-error">${esc(error.message)}</p><button class="create" id="retry">${esc(t().retry)}</button></div></div>`;
    root.querySelector('#retry').addEventListener('click', boot);
    return;
  }
  if (!workspace.org) return showCreateWorkspace();
  mountShell();
  renderRoute();
}

function showAuth(mode) {
  state.authMode = mode === 'reset-password' ? 'signin' : mode;
  root.innerHTML = renderAuth(t(), mode);
  mountAuth(root, t(), {
    onSignedIn: () => { history.replaceState(null, '', `${location.pathname}#/overview`); boot(); },
    onModeChange: (next) => { state.authMode = next; showAuth(next); },
    onLocale: toggleLocale,
  });
}

function showCreateWorkspace() {
  root.innerHTML = renderCreateWorkspace(t());
  mountCreateWorkspace(root, {
    onCreated: () => { location.hash = '#/onboarding'; boot(); },
    onSignOut: async () => { await signOut(); boot(); },
  });
}

function mountShell() {
  const dictionary = t();
  root.innerHTML = appShell(dictionary, { isArabic: state.locale === 'ar' });
  state.shellMounted = true;
  wireDropdowns(root);
  root.querySelector('#language-toggle').addEventListener('click', toggleLocale);
  root.querySelector('#mobile-menu').addEventListener('click', () => root.querySelector('#sidebar').classList.toggle('open'));
  root.querySelector('#sidebar').addEventListener('click', (event) => { if (event.target.closest('.nav-item')) root.querySelector('#sidebar').classList.remove('open'); });
  root.querySelectorAll('[data-org]').forEach((button) => button.addEventListener('click', async () => {
    try { await selectOrganization(button.dataset.org); location.hash = '#/overview'; boot(); } catch (error) { toastError(error); }
  }));
  root.querySelector('[data-action="new-workspace"]').addEventListener('click', openNewWorkspace);
  root.querySelector('[data-action="signout"]').addEventListener('click', async () => { await signOut(); boot(); });
  root.querySelectorAll('[data-create]').forEach((button) => button.addEventListener('click', () => {
    state.pendingCreate = button.dataset.create;
    go(button.dataset.create);
  }));
  wireSearch();
  wireNotifications();
  renderBanners();
}

function openNewWorkspace() {
  const dictionary = t();
  const agencies = workspace.organizations.filter((org) => org.is_agency && ['owner', 'admin'].includes(org.role));
  openModal({
    title: dictionary.newWorkspace,
    fields: [
      { name: 'name', label: dictionary.businessName, required: true },
      { name: 'industry', label: dictionary.industry },
      { name: 'timezone', label: dictionary.timezone, value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', required: true },
      { name: 'locale', label: dictionary.customerLanguage, type: 'select', options: [['ar', 'العربية'], ['en', 'English']], value: state.locale },
      ...(agencies.length ? [{ name: 'parentOrgId', label: dictionary.agencyParent, type: 'select', options: [['', dictionary.none], ...agencies.map((org) => [org.id, org.name])] }] : []),
    ],
    submitLabel: dictionary.createWorkspace,
    onSubmit: async (values) => {
      await createOrganization({ ...values, parentOrgId: values.parentOrgId || null });
      location.hash = '#/onboarding';
      boot();
    },
  });
}

async function renderBanners() {
  const dictionary = t();
  const container = root.querySelector('#banners');
  const banners = [];
  if (isImpersonating()) banners.push(`<div class="banner warning">${esc(dictionary.impersonating.replace('{name}', workspace.org.name))} <button class="link" id="exit-impersonation">${esc(dictionary.exitImpersonation)}</button></div>`);
  if (workspace.org.status === 'suspended') banners.push(`<div class="banner danger">${esc(dictionary.workspaceSuspended)}</div>`);
  container.innerHTML = banners.join('');
  container.querySelector('#exit-impersonation')?.addEventListener('click', () => { localStorage.removeItem('autexa-org'); location.hash = '#/admin'; boot(); });
  if (!can('admin')) return;
  try {
    const summary = await getUsageSummary();
    const over = usageMeters(summary).filter((meter) => meter.limit && meter.ratio >= 0.8);
    const subscription = summary.subscription || {};
    if (subscription.status === 'past_due') banners.push(`<div class="banner danger">${esc(dictionary.pastDue)} <a class="link" href="#/billing">${esc(dictionary.billing)}</a></div>`);
    if (subscription.status === 'trialing' && subscription.trial_ends_at) {
      const days = Math.ceil((new Date(subscription.trial_ends_at) - Date.now()) / 86400000);
      if (days <= 5) banners.push(`<div class="banner warning">${esc(days > 0 ? dictionary.trialEndsIn.replace('{days}', days) : dictionary.trialEnded)} <a class="link" href="#/billing">${esc(dictionary.upgrade)}</a></div>`);
    }
    over.forEach((meter) => banners.push(`<div class="banner ${meter.ratio >= 1 ? 'danger' : 'warning'}">${esc(dictionary.usageAlert.replace('{metric}', dictionary[`usage_${meter.key}`]).replace('{percent}', Math.round(meter.ratio * 100)))} <a class="link" href="#/billing">${esc(dictionary.upgrade)}</a></div>`));
    container.innerHTML = banners.join('');
    container.querySelector('#exit-impersonation')?.addEventListener('click', () => { localStorage.removeItem('autexa-org'); location.hash = '#/admin'; boot(); });
  } catch { /* usage banners are optional */ }
}

function wireSearch() {
  const dictionary = t();
  const box = root.querySelector('#global-search');
  const input = box.querySelector('input');
  const results = box.querySelector('.search-results');
  const routeFor = { customer: 'customers', conversation: 'conversations', message: 'conversations', article: 'knowledge' };
  let timer = null;
  let sequence = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      const current = ++sequence;
      try {
        const rows = await globalSearch(term);
        if (current !== sequence) return;
        results.innerHTML = rows.length ? rows.map((row) => `
          <a class="dropdown-item search-result" href="${href(routeFor[row.kind], row.id)}">
            <span class="result-kind">${esc(dictionary[`kind_${row.kind}`] || row.kind)}</span>
            <span><strong>${esc(row.title)}</strong><small>${esc(row.subtitle || '')}</small></span>
          </a>`).join('') : `<div class="dropdown-empty">${esc(dictionary.noResults)}</div>`;
        results.hidden = false;
      } catch (error) { toastError(error); }
    }, 250);
  });
  results.addEventListener('click', (event) => { if (event.target.closest('a')) { results.hidden = true; input.value = ''; } });
  input.addEventListener('keydown', (event) => { if (event.key === 'Escape') { results.hidden = true; input.blur(); } });
}

function wireNotifications() {
  const dictionary = t();
  const badge = root.querySelector('#notifications .dot-badge');
  const navBadge = root.querySelector('[data-badge="handoffs"]');
  const menu = root.querySelector('#notifications .dropdown-menu');
  const refreshCount = async () => {
    try {
      const count = await countPendingHandoffs();
      badge.hidden = !count;
      badge.textContent = count > 99 ? '99+' : count;
      if (navBadge) { navBadge.hidden = !count; navBadge.textContent = count; }
    } catch { /* ignore */ }
  };
  root.querySelector('#notifications [data-toggle]').addEventListener('click', async () => {
    menu.innerHTML = `<div class="dropdown-empty">${esc(dictionary.loading)}…</div>`;
    try {
      const pending = await getHandoffs('pending');
      menu.innerHTML = `<div class="dropdown-title">${esc(dictionary.pendingHandoffs)}</div>${pending.length ? pending.slice(0, 8).map((item) => `
        <a class="dropdown-item" href="${href('conversations', item.conversation_id)}"><span><strong>${esc(item.conversations?.customers?.full_name || item.conversations?.customers?.phone || dictionary.customer)}</strong><small>${esc(item.reason_detail || item.reason || '')} · ${esc(timeAgo(item.requested_at))}</small></span></a>`).join('') : `<div class="dropdown-empty">${esc(dictionary.allCaughtUp)}</div>`}
        <a class="dropdown-item center" href="#/handoffs">${esc(dictionary.viewAll)} →</a>`;
    } catch (error) { menu.innerHTML = `<div class="dropdown-empty">${esc(error.message)}</div>`; }
  });
  refreshCount();
  const unsubscribe = subscribe({ table: 'human_handoffs', filter: `org_id=eq.${orgId()}` }, (change) => {
    refreshCount();
    if (change.type !== 'INSERT' || change.record?.status !== 'pending') return;
    const prefs = workspace.memberPrefs || {};
    if (prefs.handoffs === false) return;
    if (prefs.sound !== false) playChime();
    if (prefs.browser !== false) browserNotify(dictionary.newHandoff, change.record.reason || '', () => go('conversations', change.record.conversation_id));
    toast(dictionary.newHandoff, 'warning');
  });
  const poll = setInterval(refreshCount, 60000);
  shellCleanups.push(unsubscribe, () => clearInterval(poll));
}

async function renderRoute() {
  const dictionary = t();
  const { route, id, rest } = parseRoute();
  const definition = routes[route];
  const page = root.querySelector('#page');
  if (!page) return;
  pageCleanup?.();
  pageCleanup = null;
  const token = ++state.renderToken;
  root.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.route === route));
  const view = document.createElement('div');
  view.className = 'page-view';
  page.replaceChildren(view);
  if (!definition || (definition.platformAdmin && !workspace.isPlatformAdmin)) {
    view.innerHTML = `<div class="empty-state"><div class="empty-orb">?</div><h1>${esc(dictionary.notFound)}</h1><a class="create" href="#/overview">${esc(dictionary.overview)}</a></div>`;
    return;
  }
  if (definition.minRole && !can(definition.minRole)) {
    view.innerHTML = `<div class="empty-state"><div class="empty-orb">⊘</div><h1>${esc(dictionary.noAccess)}</h1><p>${esc(dictionary.noAccessText)}</p></div>`;
    return;
  }
  const ctx = { t: dictionary, locale: state.locale, id, rest, route, navigate: go, refresh: renderRoute, rebootShell: boot };
  try {
    view.innerHTML = definition.module.render(ctx);
    const cleanup = await definition.module.mount?.(view, ctx);
    if (token !== state.renderToken) { if (typeof cleanup === 'function') cleanup(); return; }
    if (typeof cleanup === 'function') pageCleanup = cleanup;
    if (state.pendingCreate === route) {
      state.pendingCreate = null;
      definition.module.create?.(ctx, view);
    }
  } catch (error) {
    console.error(error);
    if (token === state.renderToken) view.insertAdjacentHTML('afterbegin', `<div class="banner danger">${esc(error.message)}</div>`);
  }
}

export { copy };
