import { esc, options } from '../../lib/html.js';
import { download, toCsv } from '../../lib/csv.js';
import { formatDate, formatMoney, formatNumber, timeAgo } from '../../lib/format.js';
import { confirmDialog, emptyRow, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import { db, query } from '../../services/supabaseClient.js';
import { workspace } from '../../services/workspace.js';

export function render({ t }) {
  if (!workspace.isPlatformAdmin) return emptyRow(t.forbidden);
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.platform)}</p><h1>${esc(t.adminConsole)}</h1><p>${esc(t.adminSubtitle)}</p></div>
      <div class="heading-actions"><button class="ghost-btn" id="claim-data">${esc(t.claimLegacyData)}</button><button class="ghost-btn" id="export-tenants">⇩ ${esc(t.exportCsv)}</button></div>
    </div>
    <div class="metric-grid" id="platform-kpis">${loadingRow(t.loading)}</div>
    <article class="panel table-panel">
      <div class="table-toolbar">
        <input type="search" class="search-input" id="tenant-search" placeholder="${esc(t.searchTenants)}" />
        <select id="tenant-status" class="compact-select">${options([['', t.all], ['active', t.active], ['suspended', t.suspended]], '')}</select>
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>${esc(t.workspace)}</th><th>${esc(t.plan)}</th><th>${esc(t.status)}</th><th>${esc(t.members)}</th><th>${esc(t.conversations)}</th><th>${esc(t.aiMessages)}</th><th>${esc(t.revenue)}</th><th>${esc(t.costs)}</th><th>${esc(t.margin)}</th><th>${esc(t.lastActivity)}</th><th></th></tr></thead>
        <tbody id="tenant-rows"><tr><td colspan="11">${loadingRow(t.loading)}</td></tr></tbody>
      </table></div>
    </article>`;
}

export async function mount(root, ctx) {
  const { t } = ctx;
  if (!workspace.isPlatformAdmin) return;
  const rowsEl = root.querySelector('#tenant-rows');
  let tenants = [];
  let plans = [];
  const margin = (tenant) => Number(tenant.revenue_usd) - Number(tenant.ai_cost_usd) - Number(tenant.wa_cost_usd);

  const renderRows = () => {
    const term = root.querySelector('#tenant-search').value.trim().toLowerCase();
    const status = root.querySelector('#tenant-status').value;
    const visible = tenants.filter((tenant) => (!status || tenant.status === status) && (!term || `${tenant.name} ${tenant.parent_name || ''}`.toLowerCase().includes(term)));
    rowsEl.innerHTML = visible.length ? visible.map((tenant) => `
      <tr data-id="${tenant.id}">
        <td><strong>${esc(tenant.name)}</strong>${tenant.is_agency ? ` <span class="tag">${esc(t.agency)}</span>` : ''}<small class="block">${tenant.parent_name ? `${esc(t.clientOf)} ${esc(tenant.parent_name)} · ` : ''}${esc(formatDate(tenant.created_at))}</small></td>
        <td><select class="compact-select" data-plan>${options(plans.map((plan) => [plan.id, plan.name]), tenant.plan_id)}</select><small class="block">${esc(t[`subStatus_${tenant.subscription_status}`] || tenant.subscription_status || '')}</small></td>
        <td><span class="status ${tenant.status === 'suspended' ? 'cancelled' : 'resolved'}">${esc(tenant.status === 'suspended' ? t.suspended : t.active)}</span></td>
        <td>${esc(formatNumber(tenant.members))}</td>
        <td>${esc(formatNumber(tenant.conversations))}</td>
        <td>${esc(formatNumber(tenant.ai_messages))}</td>
        <td>${esc(formatMoney(tenant.revenue_usd))}</td>
        <td>${esc(formatMoney(Number(tenant.ai_cost_usd) + Number(tenant.wa_cost_usd)))}<small class="block">AI ${esc(formatMoney(tenant.ai_cost_usd))} · WA ${esc(formatMoney(tenant.wa_cost_usd))}</small></td>
        <td class="${margin(tenant) < 0 ? 'danger-text' : ''}">${esc(formatMoney(margin(tenant)))}</td>
        <td>${esc(tenant.last_activity_at ? timeAgo(tenant.last_activity_at) : '—')}</td>
        <td class="row-actions">
          <button class="create small" data-impersonate>${esc(t.openWorkspace)}</button>
          <button class="ghost-btn" data-agency>${esc(tenant.is_agency ? t.removeAgency : t.makeAgency)}</button>
          <button class="ghost-btn ${tenant.status === 'suspended' ? '' : 'danger-text'}" data-suspend>${esc(tenant.status === 'suspended' ? t.activate : t.suspend)}</button>
        </td>
      </tr>`).join('') : `<tr><td colspan="11">${emptyRow(t.noTenants)}</td></tr>`;
  };

  const load = async () => {
    try {
      [tenants, plans] = await Promise.all([db.rpc('admin_tenants'), query('plans', 'select=id,name&order=sort')]);
      const sum = (key) => tenants.reduce((total, tenant) => total + Number(tenant[key] || 0), 0);
      const mrr = sum('revenue_usd');
      const costs = sum('ai_cost_usd') + sum('wa_cost_usd');
      root.querySelector('#platform-kpis').innerHTML = [
        [t.tenants, formatNumber(tenants.length)],
        [t.payingTenants, formatNumber(tenants.filter((tenant) => Number(tenant.revenue_usd) > 0).length)],
        [t.mrr, formatMoney(mrr)],
        [t.monthCosts, formatMoney(costs)],
        [t.grossMargin, mrr ? `${Math.round(((mrr - costs) / mrr) * 100)}%` : '—'],
        [t.conversationsThisMonth, formatNumber(sum('conversations'))],
      ].map(([label, value]) => `<article class="metric-card compact"><p>${esc(label)}</p><strong>${esc(value)}</strong></article>`).join('');
      renderRows();
    } catch (error) { rowsEl.innerHTML = `<tr><td colspan="11">${emptyRow(error.message)}</td></tr>`; }
  };

  root.querySelector('#tenant-search').addEventListener('input', renderRows);
  root.querySelector('#tenant-status').addEventListener('change', renderRows);
  rowsEl.addEventListener('change', async (event) => {
    if (!event.target.matches('[data-plan]')) return;
    const id = event.target.closest('tr').dataset.id;
    try { await db.rpc('admin_update_org', { p_org: id, p_plan: event.target.value }); toast(t.saved, 'success'); load(); } catch (error) { toastError(error); }
  });
  rowsEl.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const tenant = tenants.find((entry) => entry.id === button.closest('tr').dataset.id);
    try {
      if (button.matches('[data-impersonate]')) {
        localStorage.setItem('autexa-org', tenant.id);
        location.hash = '#/overview';
        await ctx.rebootShell();
        return;
      }
      if (button.matches('[data-agency]')) { await db.rpc('admin_update_org', { p_org: tenant.id, p_is_agency: !tenant.is_agency }); load(); }
      if (button.matches('[data-suspend]')) {
        const suspend = tenant.status !== 'suspended';
        if (suspend && !await confirmDialog(t.suspendConfirm.replace('{name}', tenant.name))) return;
        await db.rpc('admin_update_org', { p_org: tenant.id, p_status: suspend ? 'suspended' : 'active' });
        load();
      }
    } catch (error) { toastError(error); }
  });
  root.querySelector('#export-tenants').addEventListener('click', () => download('autexa-tenants.csv', toCsv(tenants.map((tenant) => ({ ...tenant, margin_usd: margin(tenant).toFixed(2) })), [
    ['name', 'Workspace'], ['plan_id', 'Plan'], ['subscription_status', 'Subscription'], ['status', 'Status'], ['members', 'Members'], ['conversations', 'Conversations'],
    ['ai_messages', 'AI messages'], ['revenue_usd', 'Revenue USD'], ['ai_cost_usd', 'AI cost USD'], ['wa_cost_usd', 'WhatsApp cost USD'], ['margin_usd', 'Margin USD'], ['created_at', 'Created'],
  ])));
  root.querySelector('#claim-data').addEventListener('click', () => openModal({
    title: t.claimLegacyData,
    html: `<p class="muted-text">${esc(t.claimLegacyDataHelp)}</p>`,
    fields: [{ name: 'org', label: t.workspace, type: 'select', required: true, options: tenants.map((tenant) => [tenant.id, tenant.name]), full: true }],
    submitLabel: t.claim,
    onSubmit: async (values) => { await db.rpc('claim_unassigned_data', { p_org: values.org }); toast(t.dataClaimed, 'success'); load(); },
  }));
  await load();
}
