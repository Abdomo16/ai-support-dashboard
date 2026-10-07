import { esc, initials } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDate, formatDateTime, formatMoney, timeAgo } from '../../lib/format.js';
import { download } from '../../lib/csv.js';
import { confirmDialog, emptyRow, loadingRow, toast, toastError } from '../../lib/ui.js';
import { deleteCustomer, exportCustomerData, getCustomer, saveCustomer } from '../../services/customers.js';
import { can } from '../../services/workspace.js';
import { openCustomerForm } from './Customers.js';

export function renderProfile({ t }) {
  return `<a class="back-link inline" href="#/customers">← ${esc(t.customers)}</a><div id="profile">${loadingRow(t.loading)}</div>`;
}

const section = (title, body) => `<article class="panel"><div class="panel-head"><h2>${esc(title)}</h2></div>${body}</article>`;

export async function mountProfile(root, ctx) {
  const { t, id } = ctx;
  const container = root.querySelector('#profile');
  let customer;
  try { customer = await getCustomer(id); } catch (error) { container.innerHTML = emptyRow(error.message); return; }
  if (!customer) { container.innerHTML = emptyRow(t.notFound); return; }

  const name = customer.full_name || customer.phone || t.customer;
  const csatAverage = customer.csat.length ? (customer.csat.reduce((sum, item) => sum + item.score, 0) / customer.csat.length).toFixed(1) : '—';
  const lifetimeValue = customer.orders.filter((order) => ['paid', 'fulfilled'].includes(order.status)).reduce((sum, order) => sum + Number(order.total), 0);
  const customFields = Object.entries(customer.custom_fields || {});

  container.innerHTML = `
    <div class="profile-head panel">
      <i class="customer-avatar xl">${esc(initials(name))}</i>
      <div class="profile-who">
        <h1>${esc(name)}</h1>
        <p>${esc(customer.phone || '')} ${customer.email ? `· ${esc(customer.email)}` : ''}</p>
        <div class="row-badges">${(customer.tags || []).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}
          <span class="tag ${customer.opted_in === false ? 'tag-inactive' : 'tag-light'}">${esc(customer.opted_in === false ? t.optedOut : t.optedIn)}</span></div>
      </div>
      <div class="heading-actions">
        ${can('agent') ? `<button class="ghost-btn" id="edit-customer">${esc(t.edit)}</button>` : ''}
        <button class="ghost-btn" id="export-customer">${esc(t.gdprExport)}</button>
        ${can('admin') ? `<button class="ghost-btn danger-text" id="delete-customer">${esc(t.gdprDelete)}</button>` : ''}
      </div>
    </div>
    <div class="metric-grid compact-grid">
      ${[[t.conversations, customer.conversations.length], [t.bookings, customer.appointments.length], [t.lifetimeValue, formatMoney(lifetimeValue, customer.orders[0]?.currency || 'USD')], [t.csatScore, csatAverage]]
        .map(([label, value]) => `<article class="metric-card"><strong>${esc(value)}</strong><p>${esc(label)}</p></article>`).join('')}
    </div>
    <div class="dashboard-grid">
      <div class="stack">
        ${section(t.conversations, customer.conversations.length ? customer.conversations.map((item) => `
          <a class="list-row" href="${href('conversations', item.id)}"><div><strong>${esc(item.summary || item.last_message_preview || t.noMessages)}</strong><small>${esc(timeAgo(item.last_message_at))}${item.intent ? ` · ${esc(item.intent)}` : ''}</small></div><span class="status ${esc(item.status)}">${esc(t[`status_${item.status}`] || item.status)}</span></a>`).join('') : emptyRow(t.noConversations))}
        ${section(t.bookings, customer.appointments.length ? customer.appointments.map((item) => `
          <a class="list-row" href="${href('bookings', item.id)}"><div><strong>${esc(item.services?.name || t.appointment)}</strong><small>${esc(formatDateTime(item.starts_at))}${item.team_members?.full_name ? ` · ${esc(item.team_members.full_name)}` : ''}</small></div><span class="status ${esc(item.status)}">${esc(t[`status_${item.status}`] || item.status)}</span></a>`).join('') : emptyRow(t.noBookings))}
        ${section(t.orders, customer.orders.length ? customer.orders.map((item) => `
          <a class="list-row" href="${href('orders', item.id)}"><div><strong>${esc(formatMoney(item.total, item.currency))}</strong><small>${esc(formatDateTime(item.created_at))}</small></div><span class="status ${esc(item.status)}">${esc(t[`status_${item.status}`] || item.status)}</span></a>`).join('') : emptyRow(t.noOrders))}
      </div>
      <div class="stack">
        ${section(t.details, `<dl class="details">
          <dt>${esc(t.birthday)}</dt><dd>${esc(customer.birthday ? formatDate(customer.birthday) : '—')}</dd>
          <dt>${esc(t.lastSeen)}</dt><dd>${esc(customer.last_seen_at ? timeAgo(customer.last_seen_at) : '—')}</dd>
          <dt>${esc(t.createdAt)}</dt><dd>${esc(formatDate(customer.created_at))}</dd>
          ${customFields.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>`).join('')}
        </dl>`)}
        ${section(t.notes, `<textarea id="customer-notes" class="notes-area" rows="6" ${can('agent') ? '' : 'disabled'} placeholder="${esc(t.notesPlaceholder)}">${esc(customer.notes || '')}</textarea>${can('agent') ? `<button class="ghost-btn" id="save-notes">${esc(t.save)}</button>` : ''}`)}
        ${section(t.csat, customer.csat.length ? customer.csat.map((item) => `<div class="list-row"><div><strong>${'★'.repeat(item.score)}${'☆'.repeat(5 - item.score)}</strong><small>${esc(item.comment || '')} ${esc(formatDate(item.created_at))}</small></div></div>`).join('') : emptyRow(t.noCsat))}
      </div>
    </div>`;

  container.querySelector('#edit-customer')?.addEventListener('click', () => openCustomerForm(t, customer, () => ctx.refresh()));
  container.querySelector('#save-notes')?.addEventListener('click', async () => {
    try { await saveCustomer({ ...customer, notes: container.querySelector('#customer-notes').value }); toast(t.saved, 'success'); } catch (error) { toastError(error); }
  });
  container.querySelector('#export-customer').addEventListener('click', async () => {
    try { download(`customer-${customer.id}.json`, JSON.stringify(await exportCustomerData(customer.id), null, 2), 'application/json'); } catch (error) { toastError(error); }
  });
  container.querySelector('#delete-customer')?.addEventListener('click', async () => {
    if (!await confirmDialog(t.gdprDeleteConfirm.replace('{name}', name))) return;
    try { await deleteCustomer(customer.id); toast(t.deleted, 'success'); ctx.navigate('customers'); } catch (error) { toastError(error); }
  });
}
