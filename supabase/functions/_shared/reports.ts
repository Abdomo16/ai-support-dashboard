import { env } from './http.ts';
import { admin } from './supabase.ts';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

export async function sendEmail(to: string[], subject: string, html: string) {
  const key = env('RESEND_API_KEY');
  if (!key || !to.length) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('EMAIL_FROM', 'Autexa <reports@autexa.app>'), to, subject, html }),
  });
  return response.ok;
}

// Owners/admins of a workspace who did not opt out of a given email type.
export async function recipients(orgId: string, pref: string) {
  const { data } = await admin.from('org_members').select('role, notification_prefs, profiles(email)').eq('org_id', orgId).in('role', ['owner', 'admin']);
  return (data || []).filter((member) => (member.notification_prefs as Record<string, boolean> | null)?.[pref] !== false)
    .map((member) => (member.profiles as { email?: string } | null)?.email).filter(Boolean) as string[];
}

const change = (current: number, previous: number) => {
  if (!previous) return '';
  const delta = Math.round(((current - previous) / previous) * 100);
  return ` <span style="color:${delta >= 0 ? '#16a34a' : '#dc2626'}">(${delta >= 0 ? '+' : ''}${delta}%)</span>`;
};

export async function sendWeeklyReports() {
  if (!env('RESEND_API_KEY')) return { skipped: true };
  const { data: orgs } = await admin.from('organizations').select('id, name, brand_name, brand_color').neq('status', 'suspended').limit(2000);
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86400_000);
  const appUrl = env('APP_URL');
  let sent = 0;
  for (const org of orgs || []) {
    const emails = await recipients(org.id, 'weekly_report');
    if (!emails.length) continue;
    const { data: m } = await admin.rpc('dashboard_metrics', { p_org: org.id, p_from: from.toISOString(), p_to: to.toISOString() });
    if (!m || (!m.conversations && !m.conversations_prev)) continue;
    const { data: intents } = await admin.rpc('top_intents', { p_org: org.id, p_from: from.toISOString(), p_to: to.toISOString() });
    const { count: unanswered } = await admin.from('unanswered_questions').select('id', { count: 'exact', head: true }).eq('org_id', org.id).eq('status', 'open');
    const automation = m.conversations ? Math.round((m.ai_resolved / m.conversations) * 100) : 0;
    const name = org.brand_name || org.name;
    const color = org.brand_color || '#6d28d9';
    const rows: [string, string][] = [
      ['Conversations', `${m.conversations}${change(m.conversations, m.conversations_prev)}`],
      ['Resolved by AI', `${m.ai_resolved} (${automation}%)${change(m.ai_resolved, m.ai_resolved_prev)}`],
      ['Human handoffs', `${m.handoffs}${change(m.handoffs, m.handoffs_prev)}`],
      ['New customers', String(m.new_customers)],
      ['Bookings made by AI', String(m.ai_bookings)],
      ['Revenue influenced by AI', Number(m.ai_revenue || 0).toFixed(2)],
      ['Customer satisfaction', m.csat_count ? `${m.csat_avg} / 5 (${m.csat_count} ratings)` : '—'],
      ['Unanswered questions to review', String(unanswered || 0)],
    ];
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111">
        <h2 style="color:${escape(color)}">${escape(name)} — weekly summary</h2>
        <p style="color:#555">${from.toDateString()} – ${to.toDateString()}</p>
        <table style="width:100%;border-collapse:collapse">${rows.map(([label, value]) => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escape(label)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right"><b>${value}</b></td></tr>`).join('')}</table>
        ${(intents || []).length ? `<h3>Top topics</h3><p>${(intents as { intent: string; total: number }[]).slice(0, 5).map((row) => `${escape(row.intent)} (${row.total})`).join(' · ')}</p>` : ''}
        ${appUrl ? `<p><a href="${escape(appUrl)}#/analytics" style="background:${escape(color)};color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open analytics</a></p>` : ''}
        <p style="color:#888;font-size:12px">You can turn these emails off in Settings → Notifications.</p>
      </div>`;
    if (await sendEmail(emails, `${name}: your weekly AI support report`, html)) sent += 1;
  }
  return { sent };
}

// Emails owners once per month when usage passes 80% of any plan limit.
export async function sendOverageAlerts() {
  const period = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
  const { data: counters } = await admin.from('usage_counters').select('org_id, conversations, ai_messages, alerted_at').eq('period', period).is('alerted_at', null).limit(2000);
  let alerted = 0;
  for (const counter of counters || []) {
    const { data: sub } = await admin.from('subscriptions').select('plans(name, limits)').eq('org_id', counter.org_id).maybeSingle();
    const plan = sub?.plans as { name?: string; limits?: Record<string, number> } | null;
    const limits = plan?.limits || {};
    const over = (['conversations', 'ai_messages'] as const).filter((key) => limits[key] && counter[key] / limits[key] >= 0.8);
    if (!over.length) continue;
    await admin.from('usage_counters').update({ alerted_at: new Date().toISOString() }).eq('org_id', counter.org_id).eq('period', period);
    const emails = await recipients(counter.org_id, 'usage_alerts');
    const lines = over.map((key) => `${key.replace('_', ' ')}: ${counter[key]} of ${limits[key]} (${Math.round((counter[key] / limits[key]) * 100)}%)`);
    const appUrl = env('APP_URL');
    await sendEmail(emails, 'You are close to your Autexa plan limit', `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Usage alert</h2><p>Your workspace used most of its ${escape(plan?.name || '')} plan this month:</p>
        <ul>${lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>
        <p>When a limit is reached the AI pauses and conversations go to your team.${appUrl ? ` <a href="${escape(appUrl)}#/billing">Upgrade your plan</a>.` : ''}</p>
      </div>`);
    alerted += 1;
  }
  return { alerted };
}
