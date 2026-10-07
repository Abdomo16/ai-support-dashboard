// Background jobs, called by pg_cron (see README). Deploy with --no-verify-jwt; authenticated by CRON_SECRET.
import { HttpError, json, requireEnv, serve, timingSafeEqual } from '../_shared/http.ts';
import { admin } from '../_shared/supabase.ts';
import { runReminders } from '../_shared/reminders.ts';
import { sendBroadcast } from '../_shared/broadcasts.ts';
import { runAutomations } from '../_shared/automations.ts';
import { requestCsat, summarizeResolved } from '../_shared/csat.ts';
import { syncGoogleCalendars } from '../_shared/google.ts';
import { sendOverageAlerts, sendWeeklyReports } from '../_shared/reports.ts';

async function scheduledBroadcasts() {
  const { data } = await admin.from('broadcasts').select('id, org_id').eq('status', 'scheduled').lte('scheduled_at', new Date().toISOString()).limit(20);
  const results = [];
  for (const broadcast of data || []) {
    results.push(await sendBroadcast(broadcast.org_id, broadcast.id).catch((error) => ({ error: (error as Error).message })));
  }
  return { started: results.length };
}

async function staleHandoffs() {
  // Abandoned claims go back to the queue so nobody waits forever.
  const { data } = await admin.from('human_handoffs').update({ status: 'pending', claimed_by: null, claimed_at: null })
    .eq('status', 'claimed').lte('claimed_at', new Date(Date.now() - 4 * 3600_000).toISOString()).select('id');
  return { requeued: data?.length || 0 };
}

const JOBS: Record<string, () => Promise<unknown>> = {
  reminders: runReminders,
  broadcasts: scheduledBroadcasts,
  automations: runAutomations,
  csat: requestCsat,
  insights: () => summarizeResolved(),
  google_calendar: syncGoogleCalendars,
  overage_alerts: sendOverageAlerts,
  stale_handoffs: staleHandoffs,
  retention: async () => ({ deleted: (await admin.rpc('apply_retention')).data }),
  weekly_report: sendWeeklyReports,
};

const FREQUENT = ['reminders', 'broadcasts', 'automations', 'csat', 'insights', 'google_calendar', 'overage_alerts', 'stale_handoffs'];

serve(async (request) => {
  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || request.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, requireEnv('CRON_SECRET'))) throw new HttpError(401, 'Unauthorized');
  const body = await request.json().catch(() => ({})) as { jobs?: string[] };
  const jobs = (body.jobs?.length ? body.jobs : FREQUENT).filter((job) => JOBS[job]);
  const results: Record<string, unknown> = {};
  for (const job of jobs) {
    const started = Date.now();
    try {
      results[job] = { ...(await JOBS[job]()) as object, ms: Date.now() - started };
    } catch (error) {
      console.error(`job ${job} failed`, error);
      results[job] = { error: (error as Error).message };
    }
  }
  return json(results);
});
