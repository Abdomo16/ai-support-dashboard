const icons = { overview: '⌂', conversations: '◫', agents: '✦', customers: '◉', knowledge: '▤', analytics: '◔', automations: '↗', integrations: '⌘', settings: '⚙' };

export function appShell({ locale, active, content, isArabic }) {
  const t = (key) => locale[key];
  const nav = ['overview', 'conversations', 'agents', 'customers', 'knowledge', 'analytics', 'automations', 'integrations', 'settings'];
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="#overview"><span class="brand-mark">A</span><span>autexa</span></a>
        <div class="workspace"><span class="workspace-dot"></span><span>Autexa workspace</span><span class="muted">⌄</span></div>
        <nav class="nav">${nav.map((item) => `<button class="nav-item ${active === item ? 'active' : ''}" data-route="${item}"><span>${icons[item]}</span>${t(item)}</button>`).join('')}</nav>
        <div class="sidebar-footer"><div class="avatar">AM</div><div><strong>Abdomohamed</strong><small>Administrator</small></div><button class="more">•••</button></div>
      </aside>
      <main class="main">
        <header class="topbar"><div class="mobile-brand">A</div><label class="search"><span>⌕</span><input placeholder="${t('search')}" /><kbd>⌘ K</kbd></label><div class="top-actions"><button class="icon-btn" aria-label="Notifications">◌</button><button class="language" id="language-toggle">${isArabic ? 'EN' : 'ع'}</button><button class="create" id="create-button">＋ ${t('create')}</button></div></header>
        <section class="page-content">${content}</section>
      </main>
      <div class="toast" id="toast" role="status"></div>
    </div>`;
}

export function wireShell(root, handlers) {
  root.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => handlers.navigate(button.dataset.route)));
  root.querySelector('#language-toggle')?.addEventListener('click', handlers.locale);
  root.querySelector('#create-button')?.addEventListener('click', handlers.create);
}
