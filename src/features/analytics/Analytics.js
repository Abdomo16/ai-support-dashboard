import { esc, options } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { barList, donut, heatmap, lineChart } from '../../lib/charts.js';
import { download, toCsv } from '../../lib/csv.js';
import { formatDuration, formatMoney, formatNumber, percentChange, periodRange, timeAgo } from '../../lib/format.js';
import { emptyRow, loadingRow, toastError } from '../../lib/ui.js';
import {
  getAgentPerformance, getCsatBreakdown, getMetrics, getPaidOrders, getPeakHours, getPeriodDays, getTopIntents, getTrend, getUnansweredTop, setPeriodDays,
} from '../../services/analytics.js';
import { workspace } from '../../services/workspace.js';
import { dayLabel } from '../dashboard/Overview.js';

const RANGE_KEY = 'autexa-analytics-range';

function currentRange() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RANGE_KEY));
    if (saved?.from && saved?.to) return { ...saved, custom: true };
  } catch { /* ignore malformed */ }
  return { ...periodRange(getPeriodDays()), custom: false };
}

const dateInput = (value) => new Date(value).toLocaleDateString('en-CA');

export function render({ t }) {
  const range = currentRange();
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.insightsEyebrow)}</p><h1>${esc(t.analytics)}</h1><p>${esc(t.analyticsSubtitle)}</p></div>
      <div class="heading-actions no-print">
        <select class="period" id="range-preset">${options([[7, t.last7], [30, t.last30], [90, t.last90], ['custom', t.customRange]], range.custom ? 'custom' : getPeriodDays())}</select>
        <span class="date-range" id="custom-range" ${range.custom ? '' : 'hidden'}><input type="date" id="range-from" value="${dateInput(range.from)}" /><span>–</span><input type="date" id="range-to" value="${dateInput(new Date(new Date(range.to).getTime() - 1))}" /></span>
        <button class="ghost-btn" id="export-csv">⇩ ${esc(t.exportCsv)}</button>
        <button class="ghost-btn" id="export-pdf">⎙ ${esc(t.exportPdf)}</button>
      </div>
    </div>
    <p class="print-only print-title">${esc(workspace.org?.brand_name || workspace.org?.name || '')} — ${esc(t.analytics)} (${esc(new Date(range.from).toLocaleDateString())} – ${esc(new Date(range.to).toLocaleDateString())})</p>
    <div class="metric-grid" id="kpis">${loadingRow(t.loading)}</div>
    <div class="dashboard-grid">
      <article class="panel chart-panel"><div class="panel-head"><div><h2>${esc(t.volumeAndResolution)}</h2><p>${esc(t.volumeAndResolutionHelp)}</p></div></div><div id="trend">${loadingRow(t.loading)}</div></article>
      <article class="panel resolution"><div class="panel-head"><h2>${esc(t.automationRate)}</h2></div><div id="automation">${loadingRow(t.loading)}</div></article>
    </div>
    <div class="dashboard-grid even">
      <article class="panel"><div class="panel-head"><div><h2>${esc(t.peakHours)}</h2><p>${esc(t.peakHoursHelp)}</p></div></div><div id="heatmap">${loadingRow(t.loading)}</div></article>
      <article class="panel"><div class="panel-head"><h2>${esc(t.topIntents)}</h2></div><div id="intents">${loadingRow(t.loading)}</div></article>
    </div>
    <div class="dashboard-grid even">
      <article class="panel"><div class="panel-head"><div><h2>${esc(t.knowledgeGaps)}</h2><p>${esc(t.knowledgeGapsHelp)}</p></div><a class="link no-print" href="${href('knowledge', 'unanswered')}">${esc(t.viewAll)} →</a></div><div id="gaps">${loadingRow(t.loading)}</div></article>
      <article class="panel"><div class="panel-head"><h2>${esc(t.customerSatisfaction)}</h2></div><div id="csat">${loadingRow(t.loading)}</div></article>
    </div>
    <div class="dashboard-grid even">
      <article class="panel table-panel"><div class="panel-head"><h2>${esc(t.teamPerformance)}</h2></div><div id="agents">${loadingRow(t.loading)}</div></article>
      <article class="panel"><div class="panel-head"><div><h2>${esc(t.revenue)}</h2><p>${esc(t.revenueHelp)}</p></div></div><div id="revenue">${loadingRow(t.loading)}</div></article>
    </div>`;
}

export async function mount(root, ctx) {
  const { t, locale } = ctx;
  const range = currentRange();
  const preset = root.querySelector('#range-preset');
  const custom = root.querySelector('#custom-range');
  preset.addEventListener('change', () => {
    if (preset.value === 'custom') { custom.hidden = false; return; }
    sessionStorage.removeItem(RANGE_KEY);
    setPeriodDays(Number(preset.value));
    ctx.refresh();
  });
  custom.addEventListener('change', () => {
    const from = root.querySelector('#range-from').value;
    const to = root.querySelector('#range-to').value;
    if (!from || !to || from > to) return;
    const end = new Date(`${to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    sessionStorage.setItem(RANGE_KEY, JSON.stringify({ from: new Date(`${from}T00:00:00`).toISOString(), to: end.toISOString() }));
    ctx.refresh();
  });
  root.querySelector('#export-pdf').addEventListener('click', () => window.print());

  const period = { from: range.from, to: range.to };
  const results = await Promise.allSettled([
    getMetrics(period), getTrend(period), getPeakHours(period), getTopIntents(period), getAgentPerformance(period), getCsatBreakdown(period), getUnansweredTop(), getPaidOrders(period),
  ]);
  const [metrics, trend, peaks, intents, agents, csat, gaps, orders] = results.map((result) => (result.status === 'fulfilled' ? result.value : null));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) toastError(failed.reason);

  if (metrics) {
    const automation = metrics.conversations ? Math.round((metrics.ai_resolved / metrics.conversations) * 100) : 0;
    const automationPrev = metrics.conversations_prev ? Math.round((metrics.ai_resolved_prev / metrics.conversations_prev) * 100) : 0;
    const cards = [
      [t.conversations, formatNumber(metrics.conversations), percentChange(metrics.conversations, metrics.conversations_prev), false],
      [t.aiResolved, `${formatNumber(metrics.ai_resolved)} (${automation}%)`, automationPrev ? automation - automationPrev : null, false, 'pts'],
      [t.handoffs, formatNumber(metrics.handoffs), percentChange(metrics.handoffs, metrics.handoffs_prev), true],
      [t.firstResponse, formatDuration(metrics.avg_response_seconds), percentChange(metrics.avg_response_seconds, metrics.avg_response_seconds_prev), true],
      [t.newCustomers, formatNumber(metrics.new_customers), null],
      [t.aiBookings, formatNumber(metrics.ai_bookings), null],
      [t.csatScore, metrics.csat_count ? `${metrics.csat_avg} / 5` : '—', null],
      [t.aiRevenue, formatMoney(metrics.ai_revenue, workspace.org?.settings?.currency || 'USD'), null],
    ];
    root.querySelector('#kpis').innerHTML = cards.map(([label, value, change, lowerIsBetter, unit = '%']) => `
      <article class="metric-card compact"><div class="metric-top"><p>${esc(label)}</p>${change === null || change === undefined ? '' : `<span class="metric-change ${(lowerIsBetter ? change <= 0 : change >= 0) ? 'good' : ''}">${change > 0 ? '+' : ''}${change}${unit === 'pts' ? ` ${esc(t.pts)}` : '%'}</span>`}</div><strong>${esc(value)}</strong></article>`).join('');
    root.querySelector('#automation').innerHTML = `${donut(automation, 'AI')}
      <div class="legend"><span><i class="purple"></i>${esc(t.aiResolved)} <b>${automation}%</b></span><span><i class="gray"></i>${esc(t.humanAssisted)} <b>${100 - automation}%</b></span></div>
      <dl class="details compact-details"><dt>${esc(t.inboundMessages)}</dt><dd>${esc(formatNumber(metrics.inbound))}</dd><dt>${esc(t.aiMessages)}</dt><dd>${esc(formatNumber(metrics.ai_messages))}</dd><dt>${esc(t.openNow)}</dt><dd>${esc(formatNumber(metrics.open_conversations))}</dd></dl>`;
  } else {
    root.querySelector('#kpis').innerHTML = emptyRow(t.dataUnavailable);
    root.querySelector('#automation').innerHTML = emptyRow(t.dataUnavailable);
  }

  root.querySelector('#trend').innerHTML = trend?.length ? lineChart([
    { label: t.conversations, values: trend.map((day) => Number(day.total)) },
    { label: t.aiResolved, values: trend.map((day) => Number(day.ai_resolved)) },
    { label: t.handoffs, values: trend.map((day) => Number(day.handoffs)) },
  ], { labels: trend.map((day) => dayLabel(day.day, locale)) }) : emptyRow(t.noData);

  const days = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2024, 0, 7 + index)).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { weekday: 'short', timeZone: 'UTC' }));
  root.querySelector('#heatmap').innerHTML = peaks?.length ? heatmap(peaks, days) : emptyRow(t.noData);
  root.querySelector('#intents').innerHTML = intents?.length ? barList(intents.map((row) => ({ label: t[`intent_${row.intent}`] || row.intent, value: Number(row.total) }))) : emptyRow(t.noData);

  root.querySelector('#gaps').innerHTML = gaps?.length ? `<div class="simple-list">${gaps.map((gap) => `
    <div class="list-row"><div><strong>${esc(gap.question)}</strong><small>${esc(t.askedTimes.replace('{count}', gap.occurrences))} · ${esc(timeAgo(gap.last_asked_at))}</small></div></div>`).join('')}</div>` : emptyRow(t.noUnanswered);

  if (csat?.length) {
    const counts = [5, 4, 3, 2, 1].map((score) => ({ label: '★'.repeat(score), value: csat.filter((row) => row.score === score).length }));
    const average = csat.reduce((sum, row) => sum + row.score, 0) / csat.length;
    const satisfied = Math.round((csat.filter((row) => row.score >= 4).length / csat.length) * 100);
    root.querySelector('#csat').innerHTML = `<div class="csat-summary"><strong>${average.toFixed(2)}</strong><span>/ 5 · ${esc(formatNumber(csat.length))} ${esc(t.ratings)} · ${satisfied}% ${esc(t.satisfied)}</span></div>${barList(counts)}`;
  } else root.querySelector('#csat').innerHTML = emptyRow(t.noCsatYet);

  root.querySelector('#agents').innerHTML = agents?.length ? `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>${esc(t.agent)}</th><th>${esc(t.messagesSent)}</th><th>${esc(t.conversations)}</th><th>${esc(t.handoffsResolved)}</th><th>${esc(t.avgClaimTime)}</th></tr></thead>
    <tbody>${agents.map((agent) => `<tr><td><strong>${esc(agent.full_name || agent.email)}</strong><small class="block">${esc(t[`role_${agent.role}`] || agent.role)}</small></td><td>${esc(formatNumber(agent.messages))}</td><td>${esc(formatNumber(agent.conversations))}</td><td>${esc(formatNumber(agent.handoffs_resolved))}</td><td>${esc(formatDuration(agent.avg_claim_seconds))}</td></tr>`).join('')}</tbody>
  </table></div>` : emptyRow(t.noData);

  if (orders?.length || metrics?.ai_revenue) {
    const currency = orders?.[0]?.currency || workspace.org?.settings?.currency || 'USD';
    const total = (orders || []).reduce((sum, order) => sum + Number(order.total), 0);
    const byAi = (orders || []).filter((order) => order.created_by_ai).reduce((sum, order) => sum + Number(order.total), 0);
    root.querySelector('#revenue').innerHTML = `<dl class="details">
      <dt>${esc(t.paidOrders)}</dt><dd>${esc(formatNumber(orders?.length || 0))} · ${esc(formatMoney(total, currency))}</dd>
      <dt>${esc(t.ordersByAi)}</dt><dd>${esc(formatMoney(byAi, currency))}</dd>
      <dt>${esc(t.aiInfluencedRevenue)}</dt><dd><b>${esc(formatMoney(metrics?.ai_revenue || 0, currency))}</b></dd>
      <dt>${esc(t.aiBookings)}</dt><dd>${esc(formatNumber(metrics?.ai_bookings || 0))}</dd></dl>`;
  } else root.querySelector('#revenue').innerHTML = emptyRow(t.noRevenueYet);

  root.querySelector('#export-csv').addEventListener('click', () => {
    const rows = [
      ...(metrics ? Object.entries(metrics).map(([key, value]) => ({ section: 'summary', key, value })) : []),
      ...(trend || []).flatMap((day) => [['conversations', day.total], ['ai_resolved', day.ai_resolved], ['handoffs', day.handoffs]].map(([key, value]) => ({ section: `day ${day.day}`, key, value }))),
      ...(intents || []).map((row) => ({ section: 'intent', key: row.intent, value: row.total })),
      ...(agents || []).map((agent) => ({ section: 'agent', key: agent.full_name || agent.email, value: `messages=${agent.messages}; conversations=${agent.conversations}; handoffs=${agent.handoffs_resolved}` })),
      ...(gaps || []).map((gap) => ({ section: 'unanswered', key: gap.question, value: gap.occurrences })),
    ];
    download(`autexa-analytics-${dateInput(range.from)}_${dateInput(range.to)}.csv`, toCsv(rows, [['section', 'section'], ['key', 'metric'], ['value', 'value']]));
  });
}
