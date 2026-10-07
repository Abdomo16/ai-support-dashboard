import { esc } from '../lib/html.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Weekly opening hours as { mon: [{ start: '09:00', end: '17:00' }], ... }; an empty object means open 24/7.
export function hoursEditor(t, hours = {}) {
  return `<div class="hours-editor">${DAYS.map((day) => {
    const range = hours?.[day]?.[0];
    return `<div class="hours-row" data-day="${day}">
      <label class="switch-row"><input type="checkbox" data-open ${range ? 'checked' : ''} /><span>${esc(t[`day_${day}`])}</span></label>
      <input type="time" data-start value="${esc(range?.start || '09:00')}" ${range ? '' : 'disabled'} />
      <span>–</span>
      <input type="time" data-end value="${esc(range?.end || '17:00')}" ${range ? '' : 'disabled'} />
    </div>`;
  }).join('')}<small>${esc(t.hoursHint)}</small></div>`;
}

export function wireHoursEditor(root) {
  root.querySelectorAll('.hours-row [data-open]').forEach((toggle) => toggle.addEventListener('change', () => {
    toggle.closest('.hours-row').querySelectorAll('input[type="time"]').forEach((input) => { input.disabled = !toggle.checked; });
  }));
}

export function readHours(root) {
  const hours = {};
  root.querySelectorAll('.hours-row').forEach((row) => {
    if (!row.querySelector('[data-open]').checked) return;
    const start = row.querySelector('[data-start]').value;
    const end = row.querySelector('[data-end]').value;
    if (start && end && start < end) hours[row.dataset.day] = [{ start, end }];
  });
  return hours;
}
