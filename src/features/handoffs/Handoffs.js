import { esc, initials } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDateTime, formatDuration } from '../../lib/format.js';
import { requestBrowserNotifications } from '../../lib/notify.js';
import { confirmDialog, emptyRow, loadingRow, toast, toastError, wireTabs } from '../../lib/ui.js';
import { subscribe } from '../../services/supabaseClient.js';
import { claimHandoff, getHandoffs, resolveHandoff } from '../../services/handoffs.js';
import { getAiSettings } from '../../services/aiSettings.js';
import { can, orgId, workspace } from '../../services/workspace.js';

let activeTab = 'pending';

export function render({ t }) {
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.handoffsEyebrow)}</p><h1>${esc(t.handoffs)}</h1><p>${esc(t.handoffsSubtitle)}</p></div>
      <button class="ghost-btn" id="enable-notifications">${esc(t.enableNotifications)}</button>
    </div>
    <div class="metric-grid compact-grid" id="handoff-metrics"></div>
    <article class="panel table-panel">
      <div class="table-toolbar">
        <div class="filter-tabs">${['pending', 'claimed', 'resolved', 'all'].map((tab) => `<button class="filter-tab ${tab === activeTab ? 'active' : ''}" data-tab="${tab}">${esc(t[`handoff_${tab}`])}</button>`).join('')}</div>
        <span class="source" id="sla-label"></span>
      </div>
      <div class="handoff-list" id="handoff-list">${loadingRow(t.loading)}</div>
    </article>`;
}

function slaState(item, slaMinutes) {
  const end = item.claimed_at || item.resolved_at || new Date().toISOString();
  const waited = (new Date(end) - new Date(item.requested_at)) / 1000;
  const ratio = waited / (slaMinutes * 60);
  return { waited, tone: ratio >= 1 ? 'breached' : ratio >= 0.75 ? 'warning' : 'ok' };
}

function rowHtml(item, t, slaMinutes) {
  const customer = item.conversations?.customers || {};
  const name = customer.full_name || customer.phone || t.customer;
  const sla = slaState(item, slaMinutes);
  const isVip = (customer.tags || []).some((tag) => tag.toLowerCase() === 'vip');
  const actions = can('agent') ? [
    item.status === 'pending' ? `<button class="create small" data-claim="${item.id}">${esc(t.claim)}</button>` : '',
    item.status !== 'resolved' ? `<button class="ghost-btn" data-resolve="${item.id}">${esc(t.resolve)}</button>` : '',
  ].join('') : '';
  return `
    <div class="handoff-row ${item.status === 'pending' ? sla.tone : ''}">
      <a class="handoff-main" href="${href('conversations', item.conversation_id)}">
        <i class="customer-avatar">${esc(initials(name))}</i>
        <div><strong>${esc(name)} ${isVip ? '<span class="tag tag-warn">VIP</span>' : ''} ${item.priority === 'high' ? `<span class="tag tag-inactive">${esc(t.highPriority)}</span>` : ''}</strong>
        <p>${esc(item.reason_detail || item.reason || item.conversations?.last_message_preview || '')}</p></div>
      </a>
      <div class="handoff-meta">
        <span class="sla ${item.status === 'pending' ? sla.tone : ''}" data-requested="${esc(item.requested_at)}" data-live="${item.status === 'pending'}">${esc(formatDuration(sla.waited))}</span>
        <small>${esc(item.status === 'pending' ? formatDateTime(item.requested_at) : `${t[`handoff_${item.status}`]} · ${item.profiles?.full_name || item.profiles?.email || ''}`)}</small>
      </div>
      <div class="handoff-actions">${actions}</div>
    </div>`;
}

export async function mount(root, ctx) {
  const { t } = ctx;
  const list = root.querySelector('#handoff-list');
  const settings = await getAiSettings().catch(() => null);
  const slaMinutes = settings?.sla_minutes || 15;
  root.querySelector('#sla-label').textContent = t.slaTarget.replace('{minutes}', slaMinutes);
  let items = [];

  const renderMetrics = (all) => {
    const pending = all.filter((item) => item.status === 'pending');
    const breached = pending.filter((item) => slaState(item, slaMinutes).tone === 'breached').length;
    const claimed = all.filter((item) => item.claimed_at);
    const avgClaim = claimed.length ? claimed.reduce((sum, item) => sum + (new Date(item.claimed_at) - new Date(item.requested_at)) / 1000, 0) / claimed.length : null;
    const mine = all.filter((item) => item.status === 'claimed' && item.claimed_by === workspace.user.id).length;
    root.querySelector('#handoff-metrics').innerHTML = [
      [t.handoff_pending, pending.length, 'amber'], [t.slaBreached, breached, 'danger-tone'], [t.avgTimeToClaim, formatDuration(avgClaim), 'blue'], [t.assignedToMe, mine, 'violet'],
    ].map(([label, value, tone]) => `<article class="metric-card"><strong class="${tone}-text">${esc(value)}</strong><p>${esc(label)}</p></article>`).join('');
  };

  const load = async () => {
    try {
      const all = await getHandoffs('all');
      renderMetrics(all);
      items = activeTab === 'all' ? all : all.filter((item) => item.status === activeTab);
      list.innerHTML = items.length ? items.map((item) => rowHtml(item, t, slaMinutes)).join('') : emptyRow(activeTab === 'pending' ? t.allCaughtUp : t.noHandoffs);
    } catch (error) { list.innerHTML = emptyRow(error.message); }
  };

  wireTabs(root, '.filter-tab', (tab) => { activeTab = tab; load(); });
  list.addEventListener('click', async (event) => {
    const claimId = event.target.closest('[data-claim]')?.dataset.claim;
    const resolveId = event.target.closest('[data-resolve]')?.dataset.resolve;
    try {
      if (claimId) {
        const item = items.find((entry) => entry.id === claimId);
        await claimHandoff(claimId);
        ctx.navigate('conversations', item.conversation_id);
      }
      if (resolveId) {
        const item = items.find((entry) => entry.id === resolveId);
        const handBack = await confirmDialog(t.handBackQuestion, { danger: false, confirmLabel: t.handBackToAi });
        await resolveHandoff(item, { handBackToAi: handBack });
        toast(t.handoffResolved, 'success');
        load();
      }
    } catch (error) { toastError(error); }
  });

  root.querySelector('#enable-notifications').addEventListener('click', async () => {
    const permission = await requestBrowserNotifications();
    toast(permission === 'granted' ? t.notificationsEnabled : t.notificationsBlocked, permission === 'granted' ? 'success' : 'warning');
  });

  const unsubscribe = subscribe({ table: 'human_handoffs', filter: `org_id=eq.${orgId()}` }, () => load());
  const ticker = setInterval(() => {
    list.querySelectorAll('.sla[data-live="true"]').forEach((element) => {
      const waited = (Date.now() - new Date(element.dataset.requested)) / 1000;
      element.textContent = formatDuration(waited);
      const ratio = waited / (slaMinutes * 60);
      const tone = ratio >= 1 ? 'breached' : ratio >= 0.75 ? 'warning' : 'ok';
      element.className = `sla ${tone}`;
      element.closest('.handoff-row').className = `handoff-row ${tone}`;
    });
  }, 1000);
  await load();
  return () => { unsubscribe(); clearInterval(ticker); };
}
