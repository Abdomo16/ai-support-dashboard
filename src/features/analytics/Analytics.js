import { getAnalyticsSummary } from '../../services/analytics.js';

export function analyticsPage(t) {
  return `
    <div class="page-heading">
      <div>
        <p class="eyebrow">INSIGHTS</p>
        <h1>${t.analytics}</h1>
        <p>${t.analyticsSubtitle}</p>
        <small id="analytics-data-source" class="source">Loading live Supabase data…</small>
      </div>
      <button class="period">${t.weekly} <span>⌄</span></button>
    </div>
    <div class="metric-grid analytics-metric-grid" id="analytics-metrics">${[1, 2, 3, 4].map(() => `<article class="metric-card"><div class="metric-top"><span class="metric-icon violet">◌</span></div><strong>—</strong><p>…</p></article>`).join('')}</div>
    <div class="dashboard-grid">
      <article class="panel chart-panel">
        <div class="panel-head"><div><h2>${t.conversationTrend}</h2><p id="analytics-chart-total">Loading…</p></div><button class="dots">•••</button></div>
        <div class="chart">
          <div class="chart-labels"><span id="analytics-chart-max">—</span><span id="analytics-chart-mid">—></span><span>0</span></div>
          <svg viewBox="0 0 700 205" preserveAspectRatio="none" aria-label="Conversation trend">
            <defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8b7bff" stop-opacity=".42"/><stop offset="1" stop-color="#8b7bff" stop-opacity="0"/></linearGradient></defs>
            <path id="analytics-chart-fill" fill="url(#fill)"/>
            <path id="analytics-chart-line" fill="none" stroke="#9a8cff" stroke-width="3"/>
          </svg>
          <div class="chart-days"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
        </div>
      </article>
      <article class="panel resolution">
        <div class="panel-head"><h2>${t.messageMix}</h2><button class="dots">•••</button></div>
        <div class="donut" id="message-donut"><div><strong id="message-rate">—</strong><span>Inbound</span></div></div>
        <div class="legend">
          <span><i class="purple"></i>Inbound <b id="inbound-rate">—</b></span>
          <span><i class="gray"></i>Outbound <b id="outbound-rate">—</b></span>
        </div>
      </article>
    </div>`;
}

export async function loadAnalytics(root, t) {
  const summary = await getAnalyticsSummary();
  const source = root.querySelector('#analytics-data-source');
  if (source) {
    source.textContent = summary.source === 'supabase' ? t.dataLive : t.dataUnavailable;
    source.classList.toggle('live', summary.source === 'supabase');
  }
  if (summary.source !== 'supabase') return;

  const cards = [
    { key: 'totalConversations', label: t.totalConversations, icon: '◌', tone: 'violet' },
    { key: 'openConversations', label: t.openConversations, icon: '◫', tone: 'mint' },
    { key: 'pendingHandoffs', label: t.pendingHandoffs, icon: '↗', tone: 'amber' },
    { key: 'newCustomersThisWeek', label: t.newCustomersThisWeek, icon: '◉', tone: 'blue' },
  ];

  root.querySelector('#analytics-metrics').innerHTML = cards.map((card) => `
    <article class="metric-card">
      <div class="metric-top"><span class="metric-icon ${card.tone}">${card.icon}</span></div>
      <strong>${new Intl.NumberFormat().format(summary[card.key] || 0)}</strong>
      <p>${card.label}</p>
    </article>`).join('');

  const totalMessages = (summary.inboundMessages || 0) + (summary.outboundMessages || 0);
  const inboundRate = totalMessages ? Math.round((summary.inboundMessages / totalMessages) * 100) : 0;
  root.querySelector('#message-rate').textContent = `${inboundRate}%`;
  root.querySelector('#inbound-rate').textContent = `${inboundRate}%`;
  root.querySelector('#outbound-rate').textContent = `${100 - inboundRate}%`;
  root.querySelector('#message-donut').style.background = `conic-gradient(var(--purple) 0 ${inboundRate}%, #323747 ${inboundRate}% 100%)`;

  const total = summary.totalConversations || 0;
  root.querySelector('#analytics-chart-total').textContent = `${total} ${t.conversations.toLowerCase()}`;
  drawTrend(root, summary.conversationDates);
}

function drawTrend(root, dates) {
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (6 - index)); return day;
  });
  const counts = days.map((day) => dates.filter((date) => {
    const value = new Date(date); return value.getFullYear() === day.getFullYear() && value.getMonth() === day.getMonth() && value.getDate() === day.getDate();
  }).length);
  const max = Math.max(...counts, 1);
  const points = counts.map((count, index) => `${index * (700 / 6)},${180 - (count / max) * 150}`);
  root.querySelector('#analytics-chart-line').setAttribute('d', `M${points.join(' L')}`);
  root.querySelector('#analytics-chart-fill').setAttribute('d', `M${points.join(' L')} L700,205 L0,205 Z`);
  root.querySelector('#analytics-chart-max').textContent = max;
  root.querySelector('#analytics-chart-mid').textContent = Math.ceil(max / 2);
}
