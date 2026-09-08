import { getBookings } from '../../services/bookings.js';

export function bookingsPage(t) {
  return `
    <div class="page-heading">
      <div>
        <p class="eyebrow">SCHEDULE</p>
        <h1>${t.bookings}</h1>
        <p>${t.bookingsSubtitle}</p>
        <small id="bookings-data-source" class="source">Loading live Supabase data…</small>
      </div>
      <button class="create" id="new-booking">＋ ${t.newBooking}</button>
    </div>
    <article class="panel conversation-panel">
      <div class="table-toolbar">
        <div class="filter-tabs">
          <button class="filter-tab active" data-filter="all">${t.all}</button>
          <button class="filter-tab" data-filter="upcoming">${t.upcoming}</button>
          <button class="filter-tab" data-filter="past">${t.past}</button>
        </div>
        <span class="source" id="bookings-count"></span>
      </div>
      <div class="booking-table">
        <div class="booking-row booking-header"><span>${t.customer}</span><span>${t.service}</span><span>${t.time}</span><span>${t.status}</span></div>
        <div class="booking-list" id="booking-rows"><div class="loading-row">${t.loading}…</div></div>
      </div>
    </article>`;
}

export async function loadBookingsPage(root, t, handlers) {
  const result = await getBookings();
  const source = root.querySelector('#bookings-data-source');
  const rows = root.querySelector('#booking-rows');
  const count = root.querySelector('#bookings-count');
  if (!rows) return;

  if (source) {
    source.textContent = result.source === 'supabase' ? t.dataLive : t.dataUnavailable;
    source.classList.toggle('live', result.source === 'supabase');
  }

  if (count) count.textContent = `${result.items.length} ${t.bookings.toLowerCase()}`;

  const now = Date.now();
  const renderList = (filter = 'all') => {
    const filtered = result.items.filter((item) => {
      if (filter === 'upcoming') return item.startsAt && new Date(item.startsAt).getTime() >= now;
      if (filter === 'past') return !item.startsAt || new Date(item.startsAt).getTime() < now;
      return true;
    });

    rows.innerHTML = filtered.length
      ? filtered.map((item) => `
        <div class="booking-row" data-id="${item.id}">
          <span><i class="customer-avatar">${item.customer.slice(0, 1)}</i>${item.customer}${item.createdByAi ? '<em class="ai-badge">AI</em>' : ''}</span>
          <span>${item.service}</span>
          <span>${item.when}</span>
          <span><b class="status ${item.status}">${String(item.status).replace('_', ' ')}</b></span>
        </div>`).join('')
      : `<div class="loading-row">${t.noBookings}</div>`;

    rows.querySelectorAll('.booking-row').forEach((row) => {
      row.addEventListener('click', () => handlers?.openBooking?.(row.dataset.id));
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

  root.querySelector('#new-booking')?.addEventListener('click', () => handlers?.create?.());
}
