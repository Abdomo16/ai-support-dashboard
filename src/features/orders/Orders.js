import { esc, options } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDateTime, formatMoney } from '../../lib/format.js';
import { confirmDialog, emptyRow, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import { listCustomers } from '../../services/customers.js';
import {
  ORDER_STATUSES, createPaymentLink, deleteProduct, listOrders, listProducts, saveOrder, saveProduct, setOrderStatus,
} from '../../services/orders.js';
import { can, workspace } from '../../services/workspace.js';

const tabs = ['orders', 'products'];
const CURRENCIES = ['USD', 'SAR', 'AED', 'EGP', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'MAD', 'EUR'];
const defaultCurrency = () => workspace.org?.settings?.currency || 'USD';

export function render({ t, id }) {
  const tab = tabs.includes(id) ? id : 'orders';
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.commerceEyebrow)}</p><h1>${esc(t.orders)}</h1><p>${esc(t.ordersSubtitle)}</p></div>
      ${can('agent') ? `<div class="heading-actions">${tab === 'products' ? (can('admin') ? `<button class="create" id="new-product">＋ ${esc(t.newProduct)}</button>` : '') : `<button class="create" id="new-order">＋ ${esc(t.newOrder)}</button>`}</div>` : ''}
    </div>
    <div class="page-tabs">${tabs.map((key) => `<a class="page-tab ${key === tab ? 'active' : ''}" href="${href('orders', key === 'orders' ? null : key)}">${esc(t[`ordersTab_${key}`])}</a>`).join('')}</div>
    <div id="orders-body">${loadingRow(t.loading)}</div>`;
}

export async function mount(root, ctx) {
  const { t, id } = ctx;
  const tab = tabs.includes(id) ? id : 'orders';
  const body = root.querySelector('#orders-body');
  root.querySelector('#new-order')?.addEventListener('click', () => create(ctx));
  root.querySelector('#new-product')?.addEventListener('click', () => openProductForm(t, {}, () => ctx.refresh()));
  if (tab === 'products') await mountProducts(body, ctx);
  else await mountOrders(body, ctx);
}

async function mountOrders(body, ctx) {
  const { t } = ctx;
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="table-toolbar"><div class="filter-tabs">${['all', ...ORDER_STATUSES].map((status, index) => `<button class="filter-tab ${index === 0 ? 'active' : ''}" data-filter="${status}">${esc(status === 'all' ? t.all : t[`orderStatus_${status}`])}</button>`).join('')}</div><span class="source" id="orders-total"></span></div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>${esc(t.order)}</th><th>${esc(t.customer)}</th><th>${esc(t.items)}</th><th>${esc(t.total)}</th><th>${esc(t.status)}</th><th>${esc(t.created)}</th><th></th></tr></thead>
        <tbody id="orders-rows"><tr><td colspan="7">${loadingRow(t.loading)}</td></tr></tbody>
      </table></div>
    </article>`;
  const rowsEl = body.querySelector('#orders-rows');
  let orders = [];
  const load = async (status = 'all') => {
    try {
      orders = await listOrders(status);
      const revenue = orders.filter((order) => ['paid', 'fulfilled'].includes(order.status)).reduce((sum, order) => sum + Number(order.total), 0);
      body.querySelector('#orders-total').textContent = orders.length ? `${t.paidRevenue}: ${formatMoney(revenue, orders[0].currency)}` : '';
      rowsEl.innerHTML = orders.length ? orders.map((order) => `
        <tr>
          <td><strong class="mono">${esc(order.external_id || order.id.slice(0, 8))}</strong>${order.created_by_ai ? ' <span class="ai-badge">AI</span>' : ''}</td>
          <td>${order.customers ? `<a class="link" href="${href('customers', order.customers.id)}">${esc(order.customers.full_name || order.customers.phone)}</a>` : '—'}</td>
          <td>${esc((order.items || []).map((item) => `${item.quantity}× ${item.name}`).join(', ').slice(0, 80))}</td>
          <td>${esc(formatMoney(order.total, order.currency))}</td>
          <td><span class="status ${esc(order.status)}">${esc(t[`orderStatus_${order.status}`])}</span>${order.payment_provider ? `<small class="block">${esc(t[`provider_${order.payment_provider}`])}</small>` : ''}</td>
          <td>${esc(formatDateTime(order.created_at))}</td>
          <td class="row-actions">
            ${order.status === 'pending' && can('agent') ? `<button class="create small" data-pay="${order.id}">${esc(t.paymentLink)}</button>` : ''}
            ${can('agent') ? `<select class="compact-select" data-status="${order.id}">${options(ORDER_STATUSES.map((status) => [status, t[`orderStatus_${status}`]]), order.status)}</select>` : ''}
            ${can('agent') && order.status === 'pending' ? `<button class="ghost-btn" data-edit="${order.id}">${esc(t.edit)}</button>` : ''}
          </td>
        </tr>`).join('') : `<tr><td colspan="7">${emptyRow(t.noOrders)}</td></tr>`;
    } catch (error) { rowsEl.innerHTML = `<tr><td colspan="7">${emptyRow(error.message)}</td></tr>`; }
  };
  body.querySelectorAll('.filter-tab').forEach((tab) => tab.addEventListener('click', () => {
    body.querySelectorAll('.filter-tab').forEach((other) => other.classList.toggle('active', other === tab));
    load(tab.dataset.filter);
  }));
  rowsEl.addEventListener('change', async (event) => {
    const id = event.target.dataset.status;
    if (!id) return;
    try { await setOrderStatus(id, event.target.value); toast(t.saved, 'success'); } catch (error) { toastError(error); }
  });
  rowsEl.addEventListener('click', (event) => {
    const pay = event.target.closest('[data-pay]')?.dataset.pay;
    const edit = event.target.closest('[data-edit]')?.dataset.edit;
    if (pay) openPaymentModal(t, orders.find((order) => order.id === pay), () => load());
    if (edit) openOrderForm(t, orders.find((order) => order.id === edit), () => load());
  });
  await load();
}

function openPaymentModal(t, order) {
  const { form } = openModal({
    title: t.paymentLink,
    html: `
      <p class="muted-text">${esc(t.paymentLinkHelp)}</p>
      ${order.payment_link ? `<div class="secret-box"><a class="link" href="${esc(order.payment_link)}" target="_blank" rel="noopener">${esc(order.payment_link)}</a></div>` : ''}
      <div class="form-grid">
        <div class="form-field"><label>${esc(t.provider)}</label><select name="provider"><option value="">${esc(t.defaultProvider)}</option>${options(['stripe', 'paymob', 'tap'].map((provider) => [provider, t[`provider_${provider}`]]), order.payment_provider)}</select></div>
        <div class="form-field"><label class="switch-row"><input type="checkbox" name="send" ${order.customers?.phone ? 'checked' : 'disabled'} /><span>${esc(t.sendOnWhatsApp)}</span></label></div>
      </div>`,
    submitLabel: order.payment_link ? t.regenerateLink : t.createLink,
    onSubmit: async (values) => {
      const result = await createPaymentLink(order.id, { provider: values.provider || undefined, send: values.send });
      await navigator.clipboard?.writeText(result.url).catch(() => {});
      toast(result.sent ? t.paymentLinkSent : t.paymentLinkCopied, 'success');
      return true;
    },
  });
  return form;
}

async function openOrderForm(t, order = {}, onSaved) {
  let customers = [];
  let products = [];
  try { [customers, products] = await Promise.all([listCustomers(1000), listProducts(true)]); } catch (error) { toastError(error); return; }
  let items = structuredClone(order.items?.length ? order.items : [{ name: '', quantity: 1, price: 0 }]);
  openModal({
    title: order.id ? t.editOrder : t.newOrder,
    wide: true,
    fields: [
      { name: 'customer_id', label: t.customer, type: 'select', required: true, value: order.customer_id || order.customers?.id, options: [['', t.chooseCustomer], ...customers.map((customer) => [customer.id, `${customer.full_name || t.unnamed} · ${customer.phone || ''}`])] },
      { name: 'currency', label: t.currency, type: 'select', value: order.currency || defaultCurrency(), options: CURRENCIES.map((code) => [code, code]) },
      { name: 'external_id', label: t.orderReference, value: order.external_id, hint: t.orderReferenceHint },
    ],
    html: `<h3>${esc(t.items)}</h3><div id="item-rows" class="item-rows"></div><button type="button" class="ghost-btn" id="add-item">＋ ${esc(t.addItem)}</button><p class="order-total" id="order-total"></p>`,
    onMount: (form) => {
      const rows = form.querySelector('#item-rows');
      const read = () => {
        items = [...rows.querySelectorAll('.item-row')].map((row) => ({
          product_id: row.querySelector('[data-product]').value || null,
          name: row.querySelector('[data-name]').value.trim(),
          quantity: Math.max(1, Number(row.querySelector('[data-qty]').value) || 1),
          price: Number(row.querySelector('[data-price]').value) || 0,
        }));
      };
      const total = () => {
        read();
        form.querySelector('#order-total').textContent = `${t.total}: ${formatMoney(items.reduce((sum, item) => sum + item.price * item.quantity, 0), form.querySelector('[name="currency"]').value)}`;
      };
      const renderRows = () => {
        rows.innerHTML = items.map((item, index) => `
          <div class="item-row" data-index="${index}">
            <select data-product><option value="">${esc(t.customItem)}</option>${options(products.map((product) => [product.id, product.name]), item.product_id)}</select>
            <input data-name required placeholder="${esc(t.itemName)}" value="${esc(item.name)}" />
            <input data-qty type="number" min="1" value="${esc(item.quantity)}" aria-label="${esc(t.quantity)}" />
            <input data-price type="number" min="0" step="0.01" value="${esc(item.price)}" aria-label="${esc(t.price)}" />
            <button type="button" class="icon-btn" data-remove="${index}" aria-label="${esc(t.delete)}">✕</button>
          </div>`).join('');
        total();
      };
      rows.addEventListener('input', total);
      rows.addEventListener('change', (event) => {
        if (!event.target.matches('[data-product]')) return;
        const product = products.find((entry) => entry.id === event.target.value);
        const row = event.target.closest('.item-row');
        if (product) {
          row.querySelector('[data-name]').value = product.name;
          row.querySelector('[data-price]').value = product.price;
          form.querySelector('[name="currency"]').value = product.currency;
        }
        total();
      });
      rows.addEventListener('click', (event) => {
        const index = event.target.closest('[data-remove]')?.dataset.remove;
        if (index === undefined) return;
        read();
        items.splice(Number(index), 1);
        if (!items.length) items.push({ name: '', quantity: 1, price: 0 });
        renderRows();
      });
      form.querySelector('[name="currency"]').addEventListener('change', total);
      form.querySelector('#add-item').addEventListener('click', () => { read(); items.push({ name: '', quantity: 1, price: 0 }); renderRows(); });
      form.readItems = () => { read(); return items; };
      renderRows();
    },
    onSubmit: async (values, form) => {
      const finalItems = form.readItems().filter((item) => item.name);
      if (!finalItems.length) throw new Error(t.addAtLeastOneItem);
      await saveOrder({ id: order.id, customer_id: values.customer_id, currency: values.currency, external_id: values.external_id || null, items: finalItems });
      toast(t.saved, 'success');
      onSaved?.();
    },
  });
}

async function mountProducts(body, ctx) {
  const { t } = ctx;
  body.innerHTML = `<article class="panel table-panel"><div class="table-toolbar"><span class="source">${esc(t.productsHelp)}</span></div><div class="simple-list" id="product-list">${loadingRow(t.loading)}</div></article>`;
  const list = body.querySelector('#product-list');
  let products = [];
  try { products = await listProducts(); } catch (error) { list.innerHTML = emptyRow(error.message); return; }
  list.innerHTML = products.length ? products.map((product) => `
    <div class="list-row">
      <div class="product-cell">${product.image_url ? `<img src="${esc(product.image_url)}" alt="" loading="lazy" />` : ''}<div><strong>${esc(product.name)}</strong><small>${esc(product.sku ? `${product.sku} · ` : '')}${esc(product.description?.slice(0, 120) || '')}</small></div></div>
      <div class="row-actions">
        <strong>${esc(formatMoney(product.price, product.currency))}</strong>
        ${product.stock !== null ? `<span class="tag tag-light">${esc(t.stock)}: ${esc(product.stock)}</span>` : ''}
        ${product.is_active ? '' : `<span class="tag tag-inactive">${esc(t.inactive)}</span>`}
        ${can('admin') ? `<button class="ghost-btn" data-edit="${product.id}">${esc(t.edit)}</button><button class="ghost-btn danger-text" data-delete="${product.id}">${esc(t.delete)}</button>` : ''}
      </div>
    </div>`).join('') : emptyRow(t.noProducts);
  list.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit]')?.dataset.edit;
    const remove = event.target.closest('[data-delete]')?.dataset.delete;
    if (edit) openProductForm(t, products.find((product) => product.id === edit), () => ctx.refresh());
    if (remove && await confirmDialog(t.deleteConfirm)) {
      try { await deleteProduct(remove); ctx.refresh(); } catch (error) { toastError(error); }
    }
  });
}

function openProductForm(t, product = {}, onSaved) {
  openModal({
    title: product.id ? t.editProduct : t.newProduct,
    fields: [
      { name: 'name', label: t.name, required: true, value: product.name, full: true },
      { name: 'price', label: t.price, type: 'number', min: 0, step: 0.01, required: true, value: product.price ?? '' },
      { name: 'currency', label: t.currency, type: 'select', value: product.currency || defaultCurrency(), options: CURRENCIES.map((code) => [code, code]) },
      { name: 'sku', label: 'SKU', value: product.sku },
      { name: 'stock', label: t.stock, type: 'number', min: 0, value: product.stock ?? '', hint: t.stockHint },
      { name: 'image_url', label: t.imageUrl, type: 'url', value: product.image_url, full: true },
      { name: 'description', label: t.description, type: 'textarea', rows: 3, value: product.description, hint: t.productDescriptionHint },
      { name: 'is_active', label: t.availableToAi, type: 'checkbox', value: product.is_active !== false },
    ],
    onSubmit: async (values) => {
      await saveProduct({ id: product.id, ...values, image_url: values.image_url || null, sku: values.sku || null });
      toast(t.saved, 'success');
      onSaved?.();
    },
  });
}

export function create(ctx) {
  if (!can('agent')) return;
  openOrderForm(ctx.t, {}, () => ctx.refresh());
}
