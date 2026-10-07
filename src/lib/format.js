let currentLocale = 'en';
export const setFormatLocale = (locale) => { currentLocale = locale === 'ar' ? 'ar-EG' : 'en'; };

export const formatNumber = (value) => (value === null || value === undefined ? '—' : new Intl.NumberFormat(currentLocale).format(value));

export const formatMoney = (value, currency = 'USD') => {
  try { return new Intl.NumberFormat(currentLocale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0)); } catch { return `${value} ${currency}`; }
};

export const formatDateTime = (value) => (value ? new Date(value).toLocaleString(currentLocale, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const formatDate = (value) => (value ? new Date(value).toLocaleDateString(currentLocale, { dateStyle: 'medium' }) : '—');
export const formatTime = (value) => (value ? new Date(value).toLocaleTimeString(currentLocale, { timeStyle: 'short' }) : '');

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '—';
  const total = Math.round(Number(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

export function timeAgo(value) {
  if (!value) return '';
  const rtf = new Intl.RelativeTimeFormat(currentLocale, { numeric: 'auto' });
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const steps = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [604800, 'day'], [2629800, 'week'], [31557600, 'month'], [Infinity, 'year']];
  const divisors = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
  const [, unit] = steps.find(([limit]) => Math.abs(diff) < limit);
  return rtf.format(Math.round(diff / divisors[unit]), unit);
}

export const percentChange = (current, previous) => {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
};

export const toLocalInput = (value) => {
  if (!value) return '';
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};

export function periodRange(days) {
  const to = new Date();
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return { from: from.toISOString(), to: to.toISOString() };
}
