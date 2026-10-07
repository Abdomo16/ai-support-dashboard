import { esc, initials, options } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { timeAgo } from '../../lib/format.js';
import { download, parseCsv, toCsv } from '../../lib/csv.js';
import { emptyRow, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import { allTags, listCustomers, saveCustomer, importCustomers } from '../../services/customers.js';
import { can } from '../../services/workspace.js';
import { renderProfile, mountProfile } from './CustomerProfile.js';

export function render(ctx) {
  if (ctx.id) return renderProfile(ctx);
  const { t } = ctx;
  return `
    <div class="page-heading">
      <div><p class="eyebrow">CRM</p><h1>${esc(t.customers)}</h1><p>${esc(t.customersSubtitle)}</p></div>
      <div class="heading-actions">
        ${can('agent') ? `<label class="ghost-btn file-btn">${esc(t.importCsv)}<input type="file" id="import-file" accept=".csv,text/csv" hidden /></label>` : ''}
        <button class="ghost-btn" id="export-csv">${esc(t.exportCsv)}</button>
        ${can('agent') ? `<button class="create" id="new-customer">＋ ${esc(t.newCustomer)}</button>` : ''}
      </div>
    </div>
    <article class="panel table-panel">
      <div class="table-toolbar">
        <div class="toolbar-group"><input type="search" class="search-input" id="customer-search" placeholder="${esc(t.searchCustomers)}" /><select class="mini-select" id="tag-filter"></select></div>
        <span class="source" id="customers-count"></span>
      </div>
      <div class="customer-table">
        <div class="customer-row customer-header"><span>${esc(t.customer)}</span><span>${esc(t.contact)}</span><span>${esc(t.tags)}</span><span>${esc(t.conversations)}</span><span>${esc(t.lastSeen)}</span></div>
        <div id="customer-list">${loadingRow(t.loading)}</div>
      </div>
    </article>`;
}

export function customerFields(t, customer = {}) {
  const customFields = customer.custom_fields && Object.keys(customer.custom_fields).length ? customer.custom_fields : '';
  return [
    { name: 'full_name', label: t.fullName, value: customer.full_name },
    { name: 'phone', label: t.phone, value: customer.phone, required: true, placeholder: '+9665…', hint: t.phoneHint },
    { name: 'email', label: t.email, type: 'email', value: customer.email },
    { name: 'birthday', label: t.birthday, type: 'date', value: customer.birthday },
    { name: 'tags', label: t.tags, type: 'tags', value: customer.tags || [], placeholder: 'vip, lead', full: true },
    { name: 'notes', label: t.notes, type: 'textarea', value: customer.notes, rows: 3 },
    { name: 'custom_fields', label: t.customFields, type: 'json', value: customFields, rows: 3, hint: t.customFieldsHint },
    { name: 'opted_in', label: t.optedIn, type: 'checkbox', value: customer.opted_in !== false, hint: t.optedInHint },
  ];
}

export function openCustomerForm(t, customer = {}, onSaved) {
  openModal({
    title: customer.id ? t.editCustomer : t.newCustomer,
    fields: customerFields(t, customer),
    onSubmit: async (values) => {
      const [saved] = await saveCustomer({ id: customer.id, ...values, custom_fields: values.custom_fields || {} });
      toast(t.saved, 'success');
      onSaved?.(saved);
    },
  });
}

export async function mount(root, ctx) {
  if (ctx.id) return mountProfile(root, ctx);
  const { t } = ctx;
  const list = root.querySelector('#customer-list');
  const search = root.querySelector('#customer-search');
  const tagFilter = root.querySelector('#tag-filter');
  let customers = [];

  const renderList = () => {
    const term = search.value.trim().toLowerCase();
    const tag = tagFilter.value;
    const visible = customers.filter((customer) => (!tag || (customer.tags || []).includes(tag))
      && (!term || [customer.full_name, customer.phone, customer.email].some((value) => value?.toLowerCase().includes(term))));
    root.querySelector('#customers-count').textContent = `${visible.length} ${t.customers.toLowerCase()}`;
    list.innerHTML = visible.length ? visible.map((customer) => `
      <a class="customer-row" href="${href('customers', customer.id)}">
        <span class="customer-name"><i class="customer-avatar">${esc(initials(customer.full_name || customer.phone))}</i>${esc(customer.full_name || customer.phone || t.customer)}${customer.opted_in === false ? `<span class="tag tag-inactive">${esc(t.optedOut)}</span>` : ''}</span>
        <span class="customer-contact">${esc(customer.phone || customer.email || '—')}</span>
        <span class="customer-tags">${(customer.tags || []).length ? customer.tags.map((item) => `<span class="tag">${esc(item)}</span>`).join('') : '<span class="tag tag-empty">—</span>'}</span>
        <span>${esc(customer.conversations?.[0]?.count ?? 0)}</span>
        <span class="customer-time">${esc(customer.last_seen_at ? timeAgo(customer.last_seen_at) : '—')}</span>
      </a>`).join('') : emptyRow(t.noCustomers);
  };

  const load = async () => {
    try {
      customers = await listCustomers();
      tagFilter.innerHTML = options([['', t.allTags], ...allTags(customers).map((tag) => [tag, tag])], tagFilter.value);
      renderList();
    } catch (error) { list.innerHTML = emptyRow(error.message); }
  };

  search.addEventListener('input', renderList);
  tagFilter.addEventListener('change', renderList);
  root.querySelector('#new-customer')?.addEventListener('click', () => create(ctx));
  root.querySelector('#export-csv').addEventListener('click', () => {
    download(`customers-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(customers, [['full_name', 'name'], ['phone', 'phone'], ['email', 'email'], ['tags', 'tags'], ['opted_in', 'opted_in'], ['last_seen_at', 'last_seen_at'], ['created_at', 'created_at']]));
  });
  root.querySelector('#import-file')?.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) throw new Error(t.csvEmpty);
      const result = await importCustomers(rows);
      toast(t.importResult.replace('{imported}', result.imported).replace('{skipped}', result.skipped), 'success');
      load();
    } catch (error) { toastError(error); }
    event.target.value = '';
  });
  await load();
}

export function create(ctx) {
  openCustomerForm(ctx.t, {}, (saved) => ctx.navigate('customers', saved.id));
}