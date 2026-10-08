import { esc } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDate, formatMoney, formatNumber } from '../../lib/format.js';
import { emptyRow, loadingRow, toast, toastError } from '../../lib/ui.js';
import { getPlans, getUsageSummary, openBillingPortal, startCheckout, usageMeters } from '../../services/billing.js';
import { can } from '../../services/workspace.js';

export function render({ t }) {
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.workspaceGroup)}</p><h1>${esc(t.billing)}</h1><p>${esc(t.billingSubtitle)}</p></div>
      ${can('owner') ? `<div class="heading-actions"><button class="ghost-btn" id="billing-portal">${esc(t.manageBilling)}</button></div>` : ''}
    </div>
    <section class="panel" id="current-plan">${loadingRow(t.loading)}</section>
    <h2 class="section-title">${esc(t.usageThisMonth)}</h2>
    <section class="usage-grid" id="usage">${loadingRow(t.loading)}</section>
    <h2 class="section-title">${esc(t.plans)}</h2>
    <section class="plan-grid" id="plans">${loadingRow(t.loading)}</section>`;
}

export async function mount(root, ctx) {
  const { t } = ctx;
  const checkout = new URLSearchParams(location.hash.split('?')[1] || '').get('checkout');
  if (checkout) {
    toast(checkout === 'success' ? t.checkoutSuccess : t.checkoutCancelled, checkout === 'success' ? 'success' : 'info');
    history.replaceState(null, '', href('billing'));
  }
  root.querySelector('#billing-portal')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { location.href = (await openBillingPortal()).url; } catch (error) { toastError(error); event.target.disabled = false; }
  });

  let summary;
  let plans;
  try { [summary, plans] = await Promise.all([getUsageSummary(), getPlans()]); } catch (error) {
    root.querySelector('#current-plan').innerHTML = emptyRow(error.message);
    return;
  }
  const plan = summary.plan || {};
  const subscription = summary.subscription || {};
  const trialDays = subscription.status === 'trialing' && subscription.trial_ends_at ? Math.max(0, Math.ceil((new Date(subscription.trial_ends_at) - Date.now()) / 86400000)) : null;
  root.querySelector('#current-plan').innerHTML = `
    <div class="plan-current">
      <div><p class="eyebrow">${esc(t.currentPlan)}</p><h2>${esc(plan.name || '—')}</h2>
        <p><span class="status ${subscription.status === 'active' ? 'resolved' : subscription.status === 'past_due' ? 'cancelled' : 'scheduled'}">${esc(t[`subStatus_${subscription.status}`] || subscription.status || '')}</span>
        ${trialDays !== null ? ` · ${esc(t.trialDaysLeft.replace('{days}', trialDays))}` : ''}
        ${subscription.current_period_end ? ` · ${esc(t.renewsOn)} ${esc(formatDate(subscription.current_period_end))}` : ''}</p>
      </div>
      <strong class="plan-price">${esc(formatMoney(plan.price_monthly || 0, plan.currency || 'USD'))}<small>/${esc(t.month)}</small></strong>
    </div>
    ${subscription.status === 'past_due' ? `<p class="banner warning">${esc(t.pastDueHelp)}</p>` : ''}
    ${plan.id === 'unlimited' ? `<p class="muted-text">${esc(t.complimentaryPlanHelp)}</p>` : ''}`;

  root.querySelector('#usage').innerHTML = usageMeters(summary).map((meter) => {
    const percent = Math.min(100, Math.round(meter.ratio * 100));
    const tone = meter.ratio >= 1 ? 'danger' : meter.ratio >= 0.8 ? 'warn' : '';
    return `<article class="panel usage-card ${tone}">
      <div class="usage-head"><span>${esc(t[`usage_${meter.key}`])}</span><b>${esc(formatNumber(meter.used))} / ${esc(meter.limit ? formatNumber(meter.limit) : '∞')}</b></div>
      <div class="bar-track"><i style="width:${percent}%"></i></div>
      <small>${esc(meter.ratio >= 1 ? t.limitReached : meter.ratio >= 0.8 ? t.nearLimit : `${percent}%`)}</small>
    </article>`;
  }).join('');

  if (plan.id === 'unlimited') {
    root.querySelector('#billing-portal')?.remove();
    root.querySelector('#plans').previousElementSibling.remove();
    root.querySelector('#plans').remove();
    return;
  }
  root.querySelector('#plans').innerHTML = plans.map((item) => {
    const current = item.id === plan.id;
    const limits = item.limits || {};
    return `<article class="plan-card ${current ? 'current' : ''}">
      <h3>${esc(item.name)}</h3>
      <strong class="plan-price">${esc(formatMoney(item.price_monthly, item.currency))}<small>/${esc(t.month)}</small></strong>
      <ul>${['conversations', 'ai_messages', 'seats', 'numbers'].map((key) => `<li>${esc(formatNumber(limits[key]))} ${esc(t[`usage_${key}`].toLowerCase())}</li>`).join('')}</ul>
      ${current ? `<span class="tag">${esc(t.currentPlan)}</span>` : item.price_monthly > 0 && can('owner') ? `<button class="create" data-plan="${esc(item.id)}">${esc(item.price_monthly > (plan.price_monthly || 0) ? t.upgrade : t.switchPlan)}</button>` : ''}
    </article>`;
  }).join('');
  root.querySelector('#plans').addEventListener('click', async (event) => {
    const planId = event.target.closest('[data-plan]')?.dataset.plan;
    if (!planId) return;
    event.target.disabled = true;
    try { location.href = (await startCheckout(planId)).url; } catch (error) { toastError(error); event.target.disabled = false; }
  });
  if (!can('owner')) root.querySelector('#plans').insertAdjacentHTML('afterend', `<p class="muted-text">${esc(t.ownerOnlyBilling)}</p>`);
}
