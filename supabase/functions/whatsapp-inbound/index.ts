// Inbound webhook for non-Meta WhatsApp providers (WAHA, 360dialog, Twilio, UltraMsg).
// URL per number: /functions/v1/whatsapp-inbound?account=<whatsapp_accounts.id>&key=<webhook secret>
// Deploy with --no-verify-jwt; requests are authenticated by the per-account key.
import { background, json, serve, timingSafeEqual } from '../_shared/http.ts';
import { admin } from '../_shared/supabase.ts';
import { logAiEvent } from '../_shared/ai.ts';
import { type InboundMessage, handleStatus, parseMetaMessage, processMessage } from '../_shared/inbound.ts';
import { type WhatsApp, getWhatsApp } from '../_shared/whatsapp.ts';

const digits = (value: unknown) => String(value || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
const kindOf = (mime = '') => mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'document';

type Parsed = { messages: InboundMessage[]; statuses: { id: string; status: string }[] };

function parseWaha(body: any): Parsed {
  const p = body.payload || {};
  if (body.event === 'message.ack') {
    const ack: Record<number, string> = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read', [-1]: 'failed' };
    return { messages: [], statuses: [{ id: p.id, status: ack[p.ack] || '' }] };
  }
  if (!['message', 'message.any'].includes(body.event) || p.fromMe || !String(p.from || '').endsWith('@c.us')) return { messages: [], statuses: [] };
  const mime = p.media?.mimetype;
  return {
    statuses: [],
    messages: [{
      id: p.id, from: digits(p.from), profileName: p._data?.notifyName || p._data?.pushName || null, timestamp: Number(p.timestamp) || undefined,
      inbound: p.hasMedia && p.media?.url
        ? { type: kindOf(mime), text: p.body || '', mediaUrl: p.media.url, mime, filename: p.media.filename }
        : { type: 'text', text: p.body || '' },
    }],
  };
}

function parse360(body: any): Parsed {
  const values = body.entry ? body.entry.flatMap((e: any) => (e.changes || []).map((c: any) => c.value || {})) : [body];
  const out: Parsed = { messages: [], statuses: [] };
  for (const value of values) {
    for (const status of value.statuses || []) out.statuses.push(status);
    for (const message of value.messages || []) {
      const inbound = parseMetaMessage(message);
      if (!inbound) continue;
      // 360dialog media ids are fetched through their own API, so keep the reference only.
      if (inbound.mediaId) { inbound.payload = { ...(inbound.payload || {}), media_id: inbound.mediaId }; delete inbound.mediaId; }
      const profileName = value.contacts?.find((c: any) => c.wa_id === message.from)?.profile?.name;
      out.messages.push({ id: message.id, from: message.from, profileName, timestamp: Number(message.timestamp) || undefined, inbound });
    }
  }
  return out;
}

function parseTwilio(form: URLSearchParams): Parsed {
  if (form.get('MessageStatus') && !form.get('Body') && !form.get('NumMedia')) {
    return { messages: [], statuses: [{ id: form.get('MessageSid') || '', status: form.get('MessageStatus') || '' }] };
  }
  const mediaUrl = Number(form.get('NumMedia') || 0) > 0 ? form.get('MediaUrl0') || undefined : undefined;
  const mime = form.get('MediaContentType0') || undefined;
  return {
    statuses: [],
    messages: [{
      id: form.get('MessageSid') || crypto.randomUUID(), from: digits(form.get('From')), profileName: form.get('ProfileName'),
      inbound: mediaUrl ? { type: kindOf(mime), text: form.get('Body') || '', mediaUrl, mime } : { type: 'text', text: form.get('Body') || '' },
    }],
  };
}

function parseUltraMsg(body: any): Parsed {
  const d = body.data || {};
  if (body.event_type === 'message_ack') return { messages: [], statuses: [{ id: String(d.id), status: d.ack === 'read' ? 'read' : d.ack === 'delivered' ? 'delivered' : d.ack === 'sent' ? 'sent' : '' }] };
  if (body.event_type !== 'message_received' || d.fromMe || !String(d.from || '').endsWith('@c.us')) return { messages: [], statuses: [] };
  const hasMedia = d.media && d.type !== 'chat';
  return {
    statuses: [],
    messages: [{
      id: String(d.id), from: digits(d.from), profileName: d.pushname || null, timestamp: Number(d.time) || undefined,
      inbound: hasMedia ? { type: kindOf(d.mimetype || `${d.type}/x`), text: d.body || '', mediaUrl: d.media } : { type: 'text', text: d.body || '' },
    }],
  };
}

async function handle(wa: WhatsApp, parsed: Parsed) {
  const orgId = wa.account.org_id;
  await admin.from('whatsapp_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('id', wa.account.id);
  for (const status of parsed.statuses) await handleStatus(status);
  for (const message of parsed.messages) {
    if (!message.from || !message.id) continue;
    try { await processMessage(wa, message); } catch (error) {
      await logAiEvent(orgId, 'webhook_error', { error: (error as Error).message });
    }
  }
}

serve(async (request) => {
  const url = new URL(request.url);
  if (request.method !== 'POST') return new Response('ok');
  const accountId = url.searchParams.get('account') || '';
  const key = url.searchParams.get('key') || '';
  if (!/^[0-9a-f-]{36}$/i.test(accountId) || !key) return new Response('Forbidden', { status: 403 });

  const { data: account } = await admin.from('whatsapp_accounts').select('id, org_id, provider').eq('id', accountId).eq('status', 'connected').maybeSingle();
  if (!account || account.provider === 'meta') return new Response('Forbidden', { status: 403 });
  const { data: secret } = await admin.from('integration_secrets').select('secret').eq('org_id', account.org_id).eq('provider', `whatsapp:${account.id}`).maybeSingle();
  if (!secret?.secret?.webhook_secret || !timingSafeEqual(key, secret.secret.webhook_secret)) return new Response('Forbidden', { status: 403 });

  const raw = await request.text();
  let parsed: Parsed;
  try {
    if (account.provider === 'twilio') parsed = parseTwilio(new URLSearchParams(raw));
    else {
      const body = JSON.parse(raw || '{}');
      parsed = account.provider === 'waha' ? parseWaha(body) : account.provider === '360dialog' ? parse360(body) : parseUltraMsg(body);
    }
  } catch {
    return json({ error: 'Invalid payload' }, 400);
  }
  const wa = await getWhatsApp(account.org_id, account.id);
  background(handle(wa, parsed));
  // Twilio expects TwiML; an empty response means "no auto-reply".
  if (account.provider === 'twilio') return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
  return json({ received: true });
});
