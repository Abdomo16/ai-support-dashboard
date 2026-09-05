import { metrics, activity } from '../../mocks/dashboard.js';
import { getUpcomingAppointments } from '../../services/appointments.js';
import { getDashboardSummary } from '../../services/dashboardData.js';

const metricIcons = ['◌', '✦', '↗', '◷'];

export function overview(t) {
  return `<div class="page-heading"><div><p class="eyebrow">SATURDAY, SEPTEMBER 5</p><h1>${t.greeting}</h1><p>${t.subtitle}</p><small id="dashboard-data-source" class="source">Loading live Supabase data…</small></div><button class="period">${t.weekly} <span>⌄</span></button></div>
  <div class="metric-grid">${metrics.map((m, i) => `<article class="metric-card"><div class="metric-top"><span class="metric-icon ${m.tone}">${metricIcons[i]}</span><span class="metric-change" data-change="${m.key}">${m.change}</span></div><strong data-metric="${m.key}">${m.value}</strong><p>${t[m.key]}</p><small>${t.previous}</small></article>`).join('')}</div>
  <div class="dashboard-grid"><article class="panel chart-panel"><div class="panel-head"><div><h2>${t.volume}</h2><p id="chart-total">Loading live conversations…</p></div><button class="dots">•••</button></div><div class="chart"><div class="chart-labels"><span id="chart-max">—</span><span id="chart-mid">—</span><span>0</span></div><svg viewBox="0 0 700 205" preserveAspectRatio="none" aria-label="Conversation trend"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8b7bff" stop-opacity=".42"/><stop offset="1" stop-color="#8b7bff" stop-opacity="0"/></linearGradient></defs><path id="chart-fill" fill="url(#fill)"/><path id="chart-line" fill="none" stroke="#9a8cff" stroke-width="3"/></svg><div class="chart-days"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div></div></article>
  <article class="panel resolution"><div class="panel-head"><h2>${t.resolution}</h2><button class="dots">•••</button></div><div class="donut"><div><strong id="ai-rate">—</strong><span>AI</span></div></div><div class="legend"><span><i class="purple"></i>AI resolved <b id="ai-resolved-rate">—</b></span><span><i class="gray"></i>Human assisted <b id="human-assisted-rate">—</b></span></div></article></div>
  <div class="bottom-grid"><article class="panel bookings"><div class="panel-head"><div><h2>${t.bookings}</h2><p id="booking-source" class="source">${t.dataPreview}</p></div><button class="link">${t.viewAll} →</button></div><div class="booking-table"><div class="booking-row booking-header"><span>${t.customer}</span><span>${t.service}</span><span>${t.time}</span><span>${t.status}</span></div><div id="booking-list"><div class="loading-row">Loading bookings…</div></div></div></article>
  <article class="panel activity"><div class="panel-head"><h2>${t.activity}</h2><button class="dots">•••</button></div><div class="activity-list">${activity.map(([message, time, type]) => `<div class="activity-item"><span class="activity-dot ${type}"></span><div><strong>${message}</strong><small>${time}</small></div></div>`).join('')}</div><div class="health"><span class="health-icon">✓</span><div><strong>${t.health}</strong><small>${t.healthy}</small></div></div></article></div>`;
}

export async function loadBookings(root, t) {
  const result = await getUpcomingAppointments();
  const source = root.querySelector('#booking-source');
  const list = root.querySelector('#booking-list');
  if (!list || !source) return;
  source.textContent = result.source === 'supabase' ? t.dataLive : t.dataPreview;
  source.classList.toggle('live', result.source === 'supabase');
  list.innerHTML = result.items.length ? result.items.map((item) => `<div class="booking-row"><span><i class="customer-avatar">${item.customer.slice(0, 1)}</i>${item.customer}</span><span>${item.service}</span><span>${item.when}</span><span><b class="status ${item.status}">${item.status}</b></span></div>`).join('') : '<div class="loading-row">No upcoming bookings.</div>';
}

export async function loadDashboardSummary(root) {
  const summary = await getDashboardSummary();
  const setMetric = (key, value) => {
    const element = root.querySelector(`[data-metric="${key}"]`);
    if (element) element.textContent = value === null ? '—' : new Intl.NumberFormat().format(value);
  };
  setMetric('conversations', summary.conversations);
  setMetric('aiResolved', summary.aiResolved);
  setMetric('handoffs', summary.handoffs);
  const source = root.querySelector('#dashboard-data-source');
  if (source) {
    source.textContent = summary.source === 'supabase' ? 'Live Supabase data' : 'Supabase data is unavailable';
    source.classList.toggle('live', summary.source === 'supabase');
  }
  const total = summary.conversations || 0;
  const rate = total ? Math.round((summary.aiResolved / total) * 100) : 0;
  const chartTotal = root.querySelector('#chart-total');
  if (chartTotal) chartTotal.textContent = summary.source === 'supabase' ? `${total} live conversations` : 'Live data unavailable';
  root.querySelector('#ai-rate').textContent = `${rate}%`;
  root.querySelector('#ai-resolved-rate').textContent = `${rate}%`;
  root.querySelector('#human-assisted-rate').textContent = `${100 - rate}%`;
  root.querySelector('.donut').style.background = `conic-gradient(var(--purple) 0 ${rate}%, #323747 ${rate}% 100%)`;
  drawConversationTrend(root, summary.conversationDates);
}

function drawConversationTrend(root, dates) {
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (6 - index)); return day;
  });
  const counts = days.map((day) => dates.filter((date) => {
    const value = new Date(date); return value.getFullYear() === day.getFullYear() && value.getMonth() === day.getMonth() && value.getDate() === day.getDate();
  }).length);
  const max = Math.max(...counts, 1);
  const points = counts.map((count, index) => `${index * (700 / 6)},${180 - (count / max) * 150}`);
  root.querySelector('#chart-line').setAttribute('d', `M${points.join(' L')}`);
  root.querySelector('#chart-fill').setAttribute('d', `M${points.join(' L')} L700,205 L0,205 Z`);
  root.querySelector('#chart-max').textContent = max;
  root.querySelector('#chart-mid').textContent = Math.ceil(max / 2);
}
