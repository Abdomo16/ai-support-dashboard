export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

type Range = { start: string; end: string };
export type WeeklyHours = Record<string, Range[]>;

function zoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function offsetMs(date: Date, timeZone: string) {
  const v = zoneParts(date, timeZone);
  return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second) - date.getTime();
}

// Converts a wall-clock time ("2026-10-08", "14:30") in `timeZone` to a UTC Date.
export function zonedToUtc(day: string, time: string, timeZone: string) {
  const guess = new Date(`${day}T${time}:00Z`);
  return new Date(guess.getTime() - offsetMs(guess, timeZone));
}

export function localNow(timeZone: string, date = new Date()) {
  const v = zoneParts(date, timeZone);
  return { day: `${v.year}-${v.month}-${v.day}`, time: `${v.hour}:${v.minute}`, minutes: +v.hour * 60 + +v.minute, weekday: v.weekday.toLowerCase().slice(0, 3) };
}

export function isOpen(hours: WeeklyHours | null | undefined, timeZone: string, date = new Date()) {
  if (!hours || !Object.values(hours).some((ranges) => ranges?.length)) return true;
  const now = localNow(timeZone, date);
  return (hours[now.weekday] || []).some((range) => now.time >= range.start && now.time < range.end);
}

export function describeHours(hours: WeeklyHours | null | undefined) {
  if (!hours || !Object.values(hours).some((ranges) => ranges?.length)) return 'Open 24/7';
  return WEEKDAYS.map((day) => `${day}: ${(hours[day] || []).map((range) => `${range.start}-${range.end}`).join(', ') || 'closed'}`).join('; ');
}

export const weekdayOf = (day: string) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
