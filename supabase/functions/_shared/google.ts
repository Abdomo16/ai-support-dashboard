import { env, requireEnv } from './http.ts';
import { admin, getSecret } from './supabase.ts';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export async function googleAccessToken(orgId: string) {
  const secret = await getSecret<{ refresh_token?: string }>(orgId, 'google_calendar');
  if (!secret?.refresh_token) throw new Error('Google Calendar is not connected');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refresh_token: secret.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Google token refresh failed');
  return data.access_token as string;
}

async function calendarRequest(token: string, path: string, method: string, body?: unknown) {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404 || response.status === 410) return null;
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Google Calendar error ${response.status}`);
  return data;
}

// Pushes new, changed and cancelled appointments of every connected workspace to Google Calendar.
export async function syncGoogleCalendars() {
  if (!env('GOOGLE_CLIENT_ID')) return { skipped: true };
  const { data: integrations } = await admin.from('integrations').select('org_id, config').eq('provider', 'google_calendar').eq('status', 'connected');
  let synced = 0;
  for (const integration of integrations || []) {
    try {
      const token = await googleAccessToken(integration.org_id);
      const calendarId = encodeURIComponent((integration.config as { calendar_id?: string })?.calendar_id || 'primary');
      const { data: org } = await admin.from('organizations').select('timezone').eq('id', integration.org_id).single();
      const { data: appointments } = await admin.from('appointments')
        .select('id, starts_at, ends_at, status, notes, google_event_id, google_synced_at, updated_at, customers(full_name, phone), services(name, duration_minutes), team_members(full_name)')
        .eq('org_id', integration.org_id).gte('starts_at', new Date(Date.now() - 86400000).toISOString()).limit(300);
      for (const appointment of appointments || []) {
        const stale = !appointment.google_synced_at || new Date(appointment.updated_at) > new Date(appointment.google_synced_at);
        if (!stale) continue;
        const cancelled = ['cancelled', 'no_show'].includes(appointment.status);
        let eventId = appointment.google_event_id;
        if (cancelled) {
          if (eventId) await calendarRequest(token, `/calendars/${calendarId}/events/${eventId}`, 'DELETE');
          eventId = null;
        } else {
          const end = appointment.ends_at || new Date(new Date(appointment.starts_at).getTime() + (appointment.services?.duration_minutes || 30) * 60000).toISOString();
          const event = {
            summary: `${appointment.services?.name || 'Appointment'} — ${appointment.customers?.full_name || appointment.customers?.phone || ''}`,
            description: [appointment.customers?.phone, appointment.team_members?.full_name, appointment.notes].filter(Boolean).join('\n'),
            start: { dateTime: appointment.starts_at, timeZone: org?.timezone || 'UTC' },
            end: { dateTime: end, timeZone: org?.timezone || 'UTC' },
          };
          const result = eventId
            ? await calendarRequest(token, `/calendars/${calendarId}/events/${eventId}`, 'PATCH', event)
            : null;
          eventId = result?.id || (await calendarRequest(token, `/calendars/${calendarId}/events`, 'POST', event))?.id || null;
        }
        await admin.from('appointments').update({ google_event_id: eventId, google_synced_at: new Date().toISOString() }).eq('id', appointment.id);
        synced += 1;
      }
      await admin.from('integrations').update({ last_sync_at: new Date().toISOString(), error: null }).eq('org_id', integration.org_id).eq('provider', 'google_calendar');
    } catch (error) {
      await admin.from('integrations').update({ error: (error as Error).message }).eq('org_id', integration.org_id).eq('provider', 'google_calendar');
    }
  }
  return { synced };
}
