// Meta WhatsApp Cloud API webhook. Deploy with --no-verify-jwt; requests are authenticated by the app signature.
import { background, env, hmacHex, json, serve, timingSafeEqual } from '../_shared/http.ts';
import { admin } from '../_shared/supabase.ts';
import { logAiEvent } from '../_shared/ai.ts';
import { handleStatus, parseMetaMessage, processMessage } from '../_shared/inbound.ts';
import { getWhatsApp } from '../_shared/whatsapp.ts';

async function processPayload(payload: Record<string, any>) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const { data: account } = await admin.from('whatsapp_accounts').select('id, org_id').eq('phone_number_id', phoneNumberId).eq('status', 'connected').maybeSingle();
      if (!account) continue;
      await admin.from('whatsapp_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('id', account.id);
      await logAiEvent(account.org_id, 'webhook');
      const wa = await getWhatsApp(account.org_id, account.id);
      for (const status of value.statuses || []) await handleStatus(status);
      for (const message of value.messages || []) {
        const inbound = parseMetaMessage(message);
        if (!inbound) continue;
        const profileName = value.contacts?.find((contact: any) => contact.wa_id === message.from)?.profile?.name;
        try {
          await processMessage(wa, { id: message.id, from: message.from, profileName, timestamp: Number(message.timestamp) || undefined, inbound });
        } catch (error) {
          await logAiEvent(account.org_id, 'webhook_error', { error: (error as Error).message });
        }
      }
    }
  }
}

serve(async (request) => {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const verifyToken = env('WHATSAPP_VERIFY_TOKEN');
    if (verifyToken && url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === verifyToken) {
      return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  const body = await request.text();
  const appSecret = env('WHATSAPP_APP_SECRET');
  if (appSecret) {
    const signature = request.headers.get('X-Hub-Signature-256') || '';
    if (!timingSafeEqual(signature, `sha256=${await hmacHex(appSecret, body)}`)) return new Response('Invalid signature', { status: 401 });
  }
  const payload = JSON.parse(body || '{}');
  // Meta expects a fast 200; the AI work continues in the background.
  background(processPayload(payload));
  return json({ received: true });
});
