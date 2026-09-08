import { getCustomers } from '../../services/customers.js';

export function customersPage(t) {
  return `
    <div class="page-heading">
      <div>
        <p class="eyebrow">CRM</p>
        <h1>${t.customers}</h1>
        <p>${t.customersSubtitle}</p>
        <small id="customers-data-source" class="source">Loading live Supabase data…</small>
      </div>
      <button class="create" id="new-customer">＋ ${t.newCustomer}</button>
    </div>
    <article class="panel customer-panel">
      <div class="table-toolbar">
        <span class="source" id="customers-count"></span>
      </div>
      <div class="customer-table">
        <div class="customer-row customer-header">
          <span>${t.customer}</span>
          <span>${t.contact}</span>
          <span>${t.tags}</span>
          <span>${t.conversations}</span>
          <span>${t.lastSeen}</span>
        </div>
        <div id="customer-list"><div class="loading-row">${t.loading}…</div></div>
      </div>
    </article>`;
}

export async function loadCustomers(root, t, handlers) {
  const result = await getCustomers();
  const source = root.querySelector('#customers-data-source');
  const list = root.querySelector('#customer-list');
  const count = root.querySelector('#customers-count');
  if (!list) return;

  if (source) {
    source.textContent = result.source === 'supabase' ? t.dataLive : t.dataUnavailable;
    source.classList.toggle('live', result.source === 'supabase');
  }

  if (count) count.textContent = `${result.items.length} ${t.customers.toLowerCase()}`;

  list.innerHTML = result.items.length
    ? result.items.map((item) => {
      const initials = item.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
      const lastSeen = item.lastSeenAt
        ? new Date(item.lastSeenAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        : '-';
      const tags = item.tags.length
        ? item.tags.map((tag) => `<span class="tag">${tag}</span>`).join('')
        : '<span class="tag tag-empty">—</span>';
      return `
        <div class="customer-row" data-id="${item.id}">
          <span class="customer-name"><i class="customer-avatar">${initials || 'C'}</i>${item.name}</span>
          <span class="customer-contact">${item.phone || item.email || '—'}</span>
          <span class="customer-tags">${tags}</span>
          <span>${item.conversations}</span>
          <span class="customer-time">${lastSeen}</span>
        </div>`;
    }).join('')
    : `<div class="loading-row">${t.noCustomers}</div>`;

  list.querySelectorAll('.customer-row[data-id]').forEach((row) => {
    row.addEventListener('click', () => handlers?.openCustomer?.(row.dataset.id));
  });

  root.querySelector('#new-customer')?.addEventListener('click', () => handlers?.create?.());
}
