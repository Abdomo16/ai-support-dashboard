import { getConversations } from '../../services/conversations.js';

export function conversationsPage(t) {
  return `
    <div class="page-heading">
      <div>
        <p class="eyebrow">LIVE CHATS</p>
        <h1>${t.conversations}</h1>
        <p>${t.conversationsSubtitle}</p>
        <small id="conversations-data-source" class="source">Loading live Supabase data…</small>
      </div>
      <button class="create" id="new-conversation">＋ ${t.newConversation}</button>
    </div>
    <article class="panel conversation-panel">
      <div class="table-toolbar">
        <div class="filter-tabs">
          <button class="filter-tab active" data-filter="all">${t.all}</button>
          <button class="filter-tab" data-filter="open">${t.open}</button>
          <button class="filter-tab" data-filter="resolved">${t.resolved}</button>
        </div>
        <span class="source" id="conversations-count"></span>
      </div>
      <div class="conversation-list" id="conversation-list">
        <div class="loading-row">${t.loading}…</div>
      </div>
    </article>`;
}

export async function loadConversations(root, t, handlers) {
  const result = await getConversations();
  const source = root.querySelector('#conversations-data-source');
  const list = root.querySelector('#conversation-list');
  const count = root.querySelector('#conversations-count');
  if (!list) return;

  if (source) {
    source.textContent = result.source === 'supabase' ? t.dataLive : t.dataUnavailable;
    source.classList.toggle('live', result.source === 'supabase');
  }

  if (count) count.textContent = `${result.items.length} ${t.conversations.toLowerCase()}`;

  const renderList = (filter = 'all') => {
    const filtered = filter === 'all'
      ? result.items
      : result.items.filter((item) => item.status === filter);

    list.innerHTML = filtered.length
      ? filtered.map((item) => {
        const initials = item.customer.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
        const time = item.lastMessageAt
          ? new Date(item.lastMessageAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
          : '';
        return `
          <div class="conversation-row" data-id="${item.id}">
            <div class="conversation-main">
              <i class="customer-avatar">${initials || 'C'}</i>
              <div class="conversation-meta">
                <strong>${item.customer}</strong>
                <span class="conversation-phone">${item.phone}</span>
                <p class="conversation-preview">${item.preview || t.noMessages}</p>
              </div>
            </div>
            <div class="conversation-side">
              <span class="status ${item.status}">${item.status}</span>
              ${item.isAiHandled ? '<span class="ai-badge">AI</span>' : ''}
              <span class="conversation-time">${time}</span>
            </div>
          </div>`;
      }).join('')
      : `<div class="loading-row">${t.noConversations}</div>`;

    list.querySelectorAll('.conversation-row').forEach((row) => {
      row.addEventListener('click', () => handlers?.openConversation?.(row.dataset.id));
    });
  };

  renderList();

  root.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      root.querySelectorAll('.filter-tab').forEach((btn) => btn.classList.remove('active'));
      tab.classList.add('active');
      renderList(tab.dataset.filter);
    });
  });

  root.querySelector('#new-conversation')?.addEventListener('click', () => handlers?.create?.());
}
