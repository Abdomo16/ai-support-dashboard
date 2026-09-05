export const metrics = [
  { key: 'conversations', value: '—', change: 'Live', tone: 'mint' },
  { key: 'aiResolved', value: '—', change: 'Live', tone: 'violet' },
  { key: 'handoffs', value: '—', change: 'Live', tone: 'amber' },
  { key: 'responseTime', value: '—', change: 'Not available', tone: 'blue' },
];

export const activity = [
  ['AI Nova resolved a refund question', '2 min ago', 'success'],
  ['Human handoff assigned to Maya Chen', '14 min ago', 'warning'],
  ['Knowledge source “Shipping policy” synced', '36 min ago', 'success'],
  ['VIP customer detected in WhatsApp', '1 hr ago', 'info'],
];

export const fallbackBookings = [
  { customer: 'Sarah Williams', service: 'Product consultation', when: 'Today, 3:30 PM', status: 'confirmed' },
  { customer: 'Omar Hassan', service: 'Demo & onboarding', when: 'Today, 5:00 PM', status: 'scheduled' },
  { customer: 'Nour Ahmed', service: 'Account review', when: 'Tomorrow, 10:00 AM', status: 'confirmed' },
  { customer: 'Liam Thompson', service: 'Technical support', when: 'Tomorrow, 1:30 PM', status: 'scheduled' },
];
