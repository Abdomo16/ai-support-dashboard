import { esc } from './html.js';

let chartId = 0;

export function lineChart(series, { labels = [], height = 205, colors = ['#9a8cff', '#5fe2b7', '#f7bc62'] } = {}) {
  const id = `chart-${++chartId}`;
  const max = Math.max(1, ...series.flatMap((line) => line.values));
  const count = Math.max(1, ...series.map((line) => line.values.length));
  const step = count > 1 ? 700 / (count - 1) : 0;
  const pointsFor = (values) => values.map((value, index) => `${(index * step).toFixed(1)},${(height - 25 - (value / max) * (height - 55)).toFixed(1)}`);
  const paths = series.map((line, index) => {
    const points = pointsFor(line.values);
    if (!points.length) return '';
    const color = colors[index % colors.length];
    const fill = index === 0 ? `<path fill="url(#${id}-fill)" d="M${points.join(' L')} L700,${height} L0,${height} Z"/>` : '';
    return `${fill}<path fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" d="M${points.join(' L')}"/>`;
  }).join('');
  const labelStep = Math.ceil(labels.length / 8) || 1;
  return `
    <div class="chart">
      <div class="chart-labels"><span>${max}</span><span>${Math.ceil(max / 2)}</span><span>0</span></div>
      <svg viewBox="0 0 700 ${height}" preserveAspectRatio="none" role="img">
        <defs><linearGradient id="${id}-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${colors[0]}" stop-opacity=".42"/><stop offset="1" stop-color="${colors[0]}" stop-opacity="0"/></linearGradient></defs>
        ${paths}
      </svg>
      <div class="chart-days">${labels.map((label, index) => `<span>${index % labelStep === 0 ? esc(label) : ''}</span>`).join('')}</div>
      ${series.length > 1 ? `<div class="chart-legend">${series.map((line, index) => `<span><i style="background:${colors[index % colors.length]}"></i>${esc(line.label)}</span>`).join('')}</div>` : ''}
    </div>`;
}

export function donut(rate, centerLabel) {
  return `<div class="donut" style="background:conic-gradient(var(--purple) 0 ${rate}%, #323747 ${rate}% 100%)"><div><strong>${rate}%</strong><span>${esc(centerLabel)}</span></div></div>`;
}

export function barList(items, { format = (value) => value } = {}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return `<div class="bar-list">${items.map((item) => `
    <div class="bar-item"><div class="bar-label"><span>${esc(item.label)}</span><b>${esc(format(item.value))}</b></div><div class="bar-track"><i style="width:${(item.value / max) * 100}%"></i></div></div>`).join('')}</div>`;
}

export function heatmap(cells, dayLabels) {
  const max = Math.max(1, ...cells.map((cell) => Number(cell.total)));
  const lookup = new Map(cells.map((cell) => [`${cell.dow}-${cell.hour}`, Number(cell.total)]));
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return `<div class="heatmap">
    <div class="heatmap-row heatmap-hours"><span></span>${hours.map((hour) => `<span>${hour % 3 === 0 ? hour : ''}</span>`).join('')}</div>
    ${dayLabels.map((label, dow) => `<div class="heatmap-row"><span>${esc(label)}</span>${hours.map((hour) => {
      const value = lookup.get(`${dow}-${hour}`) || 0;
      return `<i title="${esc(label)} ${hour}:00 — ${value}" style="opacity:${value ? 0.18 + (value / max) * 0.82 : 0.06}"></i>`;
    }).join('')}</div>`).join('')}
  </div>`;
}
