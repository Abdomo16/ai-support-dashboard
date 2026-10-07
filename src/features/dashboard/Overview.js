import { esc, initials, options } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { donut, lineChart } from '../../lib/charts.js';
import { formatDateTime, formatDuration, formatNumber, percentChange, periodRange, timeAgo } from '../../lib/format.js';
import { getActivityFeed, getAiHealth, getMetrics, getPeriodDays, getTrend, setPeriodDays } from '../../services/analytics.js';
import { getUpcomingAppointments } from '../../services/appointments.js';
import { workspace } from '../../services/workspace.js';

export const periodSelect = (t, days) => `<select class="period" id="period-select">${options([[7, t.last7], [30, t.last30], [90, t.last90]], days)}</select>`;

export const dayLabel = (day, locale) => new Date(`${day}T00:00:00`).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { weekday: 'short', day: 'numeric' });

function greeting(t) {
  const hour = new Date().getHours();
  const name = (workspace.profile?.full_name || '').split(' ')[0];
  const base = hour < 12 ? t.goodMorning : hour < 18 ? t.goodAfternoon : t.goodEvening;
  return name ? `${base}, ${name}` : base;
}

export function render({ t, locale }) {
  const today = new Date().toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { weekday: 'long', month: 'long', day: 'numeric' });
  const metricCards = [['conversations', '◌', 'mint'], ['aiResolved', '✦', 'violet'], ['handoffs', '↗', 'amber'], ['responseTime', '◷', 'blue']];
  return `
    ${workspace.org.onboarding_completed ? '' : `<a class="banner info setup-banner" href="#/onboarding"><strong>${esc(t.finishSetup)}</strong><span>${esc(t.finishSetupText)}</span><span>→</span></a>`}
    <div class="page-heading">
      <div><p class="eyebrow">${esc(today.toUpperCase())}</p><h1>${esc(greeting(t))}</h1><p>${esc(t.subtitle)}</p></div>
      ${periodSelect(t, getPeriodDays())}
    </div>
    <div class="metric-grid">${metricCards.map(([key, icon, tone]) => `
      <article class="metric-card"><div class="metric-top"><span class="metric-icon ${tone}">${icon}</span><span class="metric-change" data-change="${key}"></span></div>
      <strong data-metric="${key}">—</strong><p>${esc(t[key])}</p><small>${esc(t.previous)}</small></article>`).join('')}
    </div>
    <div class="dashboard-grid">
      <article class="panel chart-panel"><div class="panel-head"><div><h2>${esc(t.volume)}</h2><p id="chart-total">${esc(t.loading)}…</p></div><a class="link" href="#/analytics">${esc(t.analytics)} →</a></div><div id="trend-chart"></div></article>
      <article class="panel resolution"><div class="panel-head"><h2>${esc(t.resolution)}</h2></div><div id="resolution-donut">${donut(0, 'AI')}</div>
        <div class="legend"><span><i class="purple"></i>${esc(t.aiResolved)} <b id="ai-resolved-rate">—</b></span><span><i class="gray"></i>${esc(t.humanAssisted)} <b id="human-assisted-rate">—</b></span></div></article>
    </div>
    <div class="bottom-grid">
      <article class="panel bookings"><div class="panel-head"><div><h2>${esc(t.upcomingBookings)}</h2></div><a class="link" href="#/bookings">${esc(t.viewAll)} →</a></div>
        <div class="booking-table"><div class="booking-row booking-header"><span>${esc(t.customer)}</span><span>${esc(t.service)}</span><span>${esc(t.time)}</span><span>${esc(t.status)}</span></div><div id="booking-list"><div class="loading-row">${esc(t.loading)}…</div></div></div></article>
      <article class="panel activity"><div class="panel-head"><h2>${esc(t.activity)}</h2></div><div class="activity-list" id="activity-list"><div class="loading-row">${esc(t.loading)}…</div></div><div id="health-panel"></div></article>
    </div>`;
}

export async function mount(root, ctx) {
  const { t } = ctx;
  root.querySelector('#period-select').addEventListener('change', (event) => { setPeriodDays(Number(event.target.value)); ctx.refresh(); });
  await Promise.all([loadMetrics(root, ctx), loadBookings(root, t), loadActivity(root, t), loadHealth(root, t)]);
}

async function loadMetrics(root, { t, locale }) {
  const period = periodRange(getPeriodDays());
  try {
    const [metrics, trend] = await Promise.all([getMetrics(period), getTrend(period)]);
    const set = (key, value, current, previous, lowerIsBetter = false) => {
      root.querySelector(`[data-metric="${key}"]`).textContent = value;
      const change = percentChange(current, previous);
      const badge = root.querySelector(`[data-change="${key}"]`);
      if (change === null) { badge.textContent = ''; return; }
      badge.textContent = `${change > 0 ? '+' : ''}${change}%`;
      badge.classList.toggle('good', lowerIsBetter ? change <= 0 : change >= 0);
    };
    set('conversations', formatNumber(metrics.conversations), metrics.conversations, metrics.conversations_prev);
    set('aiResolved', formatNumber(metrics.ai_resolved), metrics.ai_resolved, metrics.ai_resolved_prev);
    set('handoffs', formatNumber(metrics.handoffs), metrics.handoffs, metrics.handoffs_prev, true);
    set('responseTime', formatDuration(metrics.avg_response_seconds), metrics.avg_response_seconds, metrics.avg_response_seconds_prev, true);
    const rate = metrics.conversations ? Math.round((metrics.ai_resolved / metrics.conversations) * 100) : 0;
    root.querySelector('#resolution-donut').innerHTML = donut(rate, 'AI');
    root.querySelector('#ai-resolved-rate').textContent = `${rate}%`;
    root.querySelector('#human-assisted-rate').textContent = `${100 - rate}%`;
    root.querySelector('#chart-total').textContent = `${formatNumber(metrics.conversations)} ${t.conversations.toLowerCase()}`;
    root.querySelector('#trend-chart').innerHTML = lineChart([{ label: t.conversations, values: trend.map((day) => Number(day.total)) }], { labels: trend.map((day) => dayLabel(day.day, locale)) });
  } catch (error) {
    root.querySelector('#chart-total').textContent = `${t.dataUnavailable}: ${error.message}`;
  }
}

async function loadBookings(root, t) {
  const list = root.querySelector('#booking-list');
  try {
    const items = await getUpcomingAppointments();
    list.innerHTML = items.length ? items.map((item) => `
      <a class="booking-row" href="${href('bookings', item.id)}"><span><i class="customer-avatar">${esc(initials(item.customer))}</i>${esc(item.customer)}</span><span>${esc(item.service)}</span><span>${esc(formatDateTime(item.startsAt))}</span><span><b class="status ${esc(item.status)}">${esc(t[`status_${item.status}`] || item.status)}</b></span></a>`).join('')
      : `<div class="loading-row">${esc(t.noUpcomingBookings)}</div>`;
  } catch (error) {
    list.innerHTML = `<div class="loading-row">${esc(error.message)}</div>`;
  }
}

const activityTone = { handoff_requested: 'warning', ai_resolved: 'success', resolved: 'success', booking_created: 'info', kb_ready: 'success', order_paid: 'success' };
const activityLink = { handoff_requested: 'conversations', ai_resolved: 'conversations', resolved: 'conversations', booking_created: 'bookings', kb_ready: 'knowledge', order_paid: 'orders' };

async function loadActivity(root, t) {
  const list = root.querySelector('#activity-list');
  try {
    const items = await getActivityFeed(6);
    list.innerHTML = items.length ? items.map((item) => `
      <a class="activity-item" href="${href(activityLink[item.kind], item.kind === 'kb_ready' ? 'documents' : item.entity_id)}"><span class="activity-dot ${activityTone[item.kind] || 'info'}"></span>
      <div><strong>${esc((t[`activity_${item.kind}`] || item.kind).replace('{name}', item.subject || t.customer))}</strong><small>${esc(timeAgo(item.created_at))}</small></div></a>`).join('')
      : `<div class="loading-row">${esc(t.noActivity)}</div>`;
  } catch (error) {
    list.innerHTML = `<div class="loading-row">${esc(error.message)}</div>`;
  }
}

export function healthPanel(t, health) {
  const accounts = health.whatsapp || [];
  const connected = accounts.some((account) => account.status === 'connected');
  const errorRate = health.replies + health.errors ? Math.round((health.errors / (health.replies + health.errors)) * 100) : 0;
  const lastWebhook = accounts.map((account) => account.last_webhook_at).filter(Boolean).sort().pop();
  const problems = [];
  if (!connected) problems.push(t.healthNoWhatsapp);
  if (!health.is_live) problems.push(t.healthNotLive);
  if (errorRate >= 10) problems.push(t.healthErrors.replace('{rate}', errorRate));
  const ok = !problems.length;
  return `
    <div class="health ${ok ? '' : 'warn'}"><span class="health-icon">${ok ? '✓' : '!'}</span><div><strong>${esc(t.health)}</strong><small>${esc(ok ? t.healthy : problems.join(' · '))}</small></div></div>
    <div class="health-stats">
      <span><small>${esc(t.lastWebhook)}</small><b>${esc(lastWebhook ? timeAgo(lastWebhook) : '—')}</b></span>
      <span><small>${esc(t.aiLatency)}</small><b>${health.avg_latency_ms ? `${formatNumber(health.avg_latency_ms)} ms` : '—'}</b></span>
      <span><small>${esc(t.errorRate)}</small><b>${errorRate}%</b></span>
      <span><small>${esc(t.tokens24h)}</small><b>${formatNumber(health.tokens || 0)}</b></span>
    </div>`;
}

async function loadHealth(root, t) {
  try {
    root.querySelector('#health-panel').innerHTML = healthPanel(t, await getAiHealth());
  } catch { /* health panel is optional */ }
}
