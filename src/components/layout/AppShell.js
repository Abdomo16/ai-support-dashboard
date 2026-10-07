import { esc, initials } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { themeButton } from '../../lib/theme.js';
import { navGroups, routeEnabled, routes } from '../../app/routes.js';
import { can, isImpersonating, workspace } from '../../services/workspace.js';

const createItems = [['conversations', 'newConversation'], ['customers', 'newCustomer'], ['bookings', 'newBooking'], ['knowledge', 'newArticle'], ['broadcasts', 'newBroadcast'], ['orders', 'newOrder']];

export function appShell(t, { isArabic }) {
  const org = workspace.org;
  const brandName = org.brand_name || 'autexa';
  const visible = Object.entries(routes).filter(([key, def]) => !def.hidden && (!def.platformAdmin || workspace.isPlatformAdmin) && (!def.minRole || can(def.minRole))
    && routeEnabled(key, def, org.features));
  const nav = navGroups.map((group) => {
    const items = visible.filter(([, def]) => def.group === group);
    if (!items.length) return '';
    return `<div class="nav-group"><small>${esc(t[group])}</small>${items.map(([key, def]) => `
      <a class="nav-item" data-route="${key}" href="${href(key)}"><span>${def.icon}</span>${esc(t[def.label || key])}${def.badge ? `<b class="nav-badge" data-badge="${def.badge}" hidden></b>` : ''}</a>`).join('')}</div>`;
  }).join('');
  const name = workspace.profile?.full_name || workspace.profile?.email || '';
  return `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <a class="brand" href="#/overview">${org.logo_url ? `<img class="brand-logo" src="${esc(org.logo_url)}" alt="" />` : `<span class="brand-mark">${esc(brandName.slice(0, 1).toUpperCase())}</span>`}<span>${esc(brandName)}</span></a>
        <div class="dropdown" id="workspace-switcher">
          <button class="workspace" type="button" data-toggle><span class="workspace-dot ${org.status === 'suspended' ? 'off' : ''}"></span><span class="workspace-name">${esc(org.name)}</span><span class="muted">⌄</span></button>
          <div class="dropdown-menu" hidden>
            ${workspace.organizations.map((item) => `<button type="button" class="dropdown-item ${item.id === org.id ? 'active' : ''}" data-org="${item.id}"><span>${esc(item.name)}</span><small>${esc(t[`role_${item.role}`] || item.role)}</small></button>`).join('')}
            <hr />
            <button type="button" class="dropdown-item" data-action="new-workspace">＋ ${esc(t.newWorkspace)}</button>
          </div>
        </div>
        <nav class="nav">${nav}</nav>
        <div class="sidebar-footer dropdown" id="user-menu">
          <div class="avatar">${esc(initials(name))}</div>
          <div class="user-meta"><strong>${esc(name)}</strong><small>${esc(t[`role_${workspace.role}`] || workspace.role)}</small></div>
          <button class="more" type="button" data-toggle aria-label="${esc(t.account)}">•••</button>
          <div class="dropdown-menu up" hidden>
            <a class="dropdown-item" href="#/settings/profile">${esc(t.profile)}</a>
            <a class="dropdown-item" href="#/settings/notifications">${esc(t.notificationSettings)}</a>
            <button type="button" class="dropdown-item" data-action="signout">${esc(t.signOut)}</button>
          </div>
        </div>
      </aside>
      <main class="main">
        <div id="banners"></div>
        <header class="topbar">
          <button class="mobile-brand" id="mobile-menu" type="button" aria-label="Menu">☰</button>
          <div class="search dropdown" id="global-search">
            <span>⌕</span><input placeholder="${esc(t.search)}" autocomplete="off" /><kbd>Ctrl K</kbd>
            <div class="dropdown-menu search-results" hidden></div>
          </div>
          <div class="top-actions">
            <div class="dropdown" id="notifications">
              <button class="icon-btn" type="button" data-toggle aria-label="${esc(t.notifications)}">◎<b class="dot-badge" hidden></b></button>
              <div class="dropdown-menu notifications-menu" hidden></div>
            </div>
            ${themeButton(t)}
            <button class="language" id="language-toggle" type="button">${isArabic ? 'EN' : 'ع'}</button>
            ${can('agent') ? `<div class="dropdown" id="create-menu">
              <button class="create" id="create-button" type="button" data-toggle>＋ ${esc(t.create)}</button>
              <div class="dropdown-menu" hidden>${createItems.map(([route, label]) => `<button type="button" class="dropdown-item" data-create="${route}">${esc(t[label])}</button>`).join('')}</div>
            </div>` : ''}
          </div>
        </header>
        <section class="page-content" id="page"></section>
      </main>
      <div class="toast" id="toast" role="status"></div>
    </div>`;
}

let outsideClickHandler = null;

export function wireDropdowns(root) {
  const closeAll = (except) => root.querySelectorAll('.dropdown-menu').forEach((menu) => { if (menu !== except && !menu.closest('#global-search')) menu.hidden = true; });
  root.querySelectorAll('.dropdown [data-toggle]').forEach((toggle) => toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = toggle.closest('.dropdown').querySelector('.dropdown-menu');
    closeAll(menu);
    menu.hidden = !menu.hidden;
  }));
  document.removeEventListener('click', outsideClickHandler);
  outsideClickHandler = (event) => {
    if (!event.target.closest('.dropdown')) {
      closeAll();
      const results = root.querySelector('#global-search .dropdown-menu');
      if (results) results.hidden = true;
    }
  };
  document.addEventListener('click', outsideClickHandler);
  root.querySelectorAll('.dropdown-menu').forEach((menu) => menu.addEventListener('click', (event) => {
    if (event.target.closest('.dropdown-item') && !menu.closest('#global-search')) menu.hidden = true;
  }));
}
