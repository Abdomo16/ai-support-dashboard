import { hmacHex } from './http.ts';
import { admin, getSecret } from './supabase.ts';

export type EventName =
  | 'message.received' | 'message.sent' | 'conversation.resolved' | 'handoff.requested'
  | 'customer.created' | 'booking.created' | 'order.created' | 'order.paid' | 'csat.received' | 'automation.fired';

// Fans an event out to the workspace's outgoing webhook (Zapier/Make/custom) and Google Sheets integrations.
export async function emitEvent(orgId: string, event: EventName, data: Record<string, unknown>) {
  const { data: integrations } = await admin.from('integrations').select('provider, config')
    .eq('org_id', orgId).eq('status', 'connected').in('provider', ['webhook', 'google_sheets']);
  if (!integrations?.length) return;
  const body = JSON.stringify({ event, org_id: orgId, created_at: new Date().toISOString(), data });
  await Promise.allSettled(integrations.map(async (integration) => {
    const config = integration.config as { url?: string; events?: string[] };
    if (!config.url || (config.events?.length && !config.events.includes(event))) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Autexa-Event': event };
    if (integration.provider === 'webhook') {
      const secret = await getSecret<{ signing_secret?: string }>(orgId, 'webhook');
      if (secret?.signing_secret) headers['X-Autexa-Signature'] = `sha256=${await hmacHex(secret.signing_secret, body)}`;
    }
    await fetch(config.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
  }));
}
