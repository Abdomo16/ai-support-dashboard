// Meta WhatsApp Cloud API webhook. Deploy with --no-verify-jwt; requests are authenticated by the app signature.
import { background, env, hmacHex, json, serve, timingSafeEqual } from '../_shared/http.ts';
import { admin } from '../_shared/supabase.ts';
import { type ChatMessage, logAiEvent, transcribe } from '../_shared/ai.ts';
import { recordUnanswered, runAgent } from '../_shared/agent.ts';
import { refreshBroadcastStats } from '../_shared/broadcasts.ts';
import { emitEvent } from '../_shared/events.ts';
import { withinPlanLimits } from '../_shared/limits.ts';
import { createHandoff, deliver, ensureCustomer, openConversation } from '../_shared/messaging.ts';
import { isOpen } from '../_shared/time.ts';
import { type WhatsApp, downloadMedia, getWhatsApp } from '../_shared/whatsapp.ts';

const OPT_OUT = /^(stop|unsubscribe|الغاء|إلغاء|توقف|الغاء الاشتراك)$/i;
const OPT_IN = /^(start|subscribe|اشتراك)$/i;

type Inbound = { type: string; text: string; mediaId?: string; mime?: string; filename?: string; payload?: Record<string, unknown>; replyId?: string };

function parseInbound(message: Record<string, any>): Inbound | null {
  const type = message.type;
  switch (type) {
    case 'text': return { type, text: message.text?.body || '' };
    case 'image': case 'video': case 'audio': case 'document': case 'sticker':
      return { type, text: message[type]?.caption || '', mediaId: message[type]?.id, mime: message[type]?.mime_type, filename: message.document?.filename };
    case 'location': return { type, text: message.location?.name || message.location?.address || '', payload: message.location };
    case 'interactive': {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply;
      return { type, text: reply?.title || '', replyId: reply?.id };
    }
    case 'button': return { type: 'interactive', text: message.button?.text || '', replyId: message.button?.payload };
    case 'contacts': return { type: 'text', text: (message.contacts || []).map((contact: any) => `${contact.name?.formatted_name || ''} ${contact.phones?.[0]?.phone || ''}`).join('\n') };
    case 'reaction': return null;
    default: return { type: 'text', text: `[${type}]` };
  }
}

const ack: Record<string, Record<string, string>> = {
  en: { optOut: 'You have been unsubscribed from our messages. Reply START to subscribe again.', optIn: 'You are subscribed again. Welcome back!', csatThanks: 'Thank you for your feedback!', confirmed: 'Your appointment is confirmed. See you soon!' },
  ar: { optOut: 'تم إلغاء اشتراكك في رسائلنا. أرسل START للاشتراك مجدداً.', optIn: 'تم تفعيل اشتراكك مجدداً. أهلاً بعودتك!', csatThanks: 'شكراً لتقييمك!', confirmed: 'تم تأكيد موعدك. نراك قريباً!' },
};

async function handleStatus(status: Record<string, any>) {
  const map: Record<string, string> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
  const value = map[status.status];
  if (!value) return;
  await admin.from('messages').update({ delivery_status: value }).eq('wa_message_id', status.id);
  const { data: recipient } = await admin.from('broadcast_recipients').select('id, broadcast_id, status').eq('wa_message_id', status.id).maybeSingle();
  if (!recipient || recipient.status === 'replied') return;
  const order = ['queued', 'sent', 'delivered', 'read'];
  if (value === 'failed' || order.indexOf(value) > order.indexOf(recipient.status)) {
    await admin.from('broadcast_recipients').update({ status: value, error: status.errors?.[0]?.title ?? null, updated_at: new Date().toISOString() }).eq('id', recipient.id);
    await refreshBroadcastStats(recipient.broadcast_id);
  }
}

async function storeMedia(wa: WhatsApp, orgId: string, conversationId: string, inbound: Inbound, messageId: string) {
  const { bytes, mime } = await downloadMedia(wa, inbound.mediaId!);
  const extension = (inbound.filename?.split('.').pop() || mime.split('/')[1]?.split(';')[0] || 'bin').replace(/[^\w]/g, '');
  const path = `${orgId}/${conversationId}/${messageId}.${extension}`;
  await admin.storage.from('media').upload(path, bytes, { contentType: mime, upsert: true });
  return { path, mime, bytes };
}

async function processMessage(wa: WhatsApp, value: Record<string, any>, raw: Record<string, any>) {
  const orgId = wa.account.org_id;
  const { data: duplicate } = await admin.from('messages').select('id').eq('wa_message_id', raw.id).limit(1).maybeSingle();
  if (duplicate) return;
  const inbound = parseInbound(raw);
  if (!inbound) return;

  const [{ data: org }, { data: settings }] = await Promise.all([
    admin.from('organizations').select('*').eq('id', orgId).single(),
    admin.from('ai_settings').select('*').eq('org_id', orgId).maybeSingle(),
  ]);
  const lang = org?.locale === 'ar' ? 'ar' : 'en';
  const profileName = value.contacts?.find((contact: any) => contact.wa_id === raw.from)?.profile?.name;
  const customer = await ensureCustomer(orgId, raw.from, profileName);
  // CSAT answers belong to the (already resolved) conversation that asked for them.
  const rated = inbound.replyId?.startsWith('csat_')
    ? (await admin.from('conversations').select('*').eq('customer_id', customer.id).not('csat_requested_at', 'is', null)
      .order('csat_requested_at', { ascending: false }).limit(1).maybeSingle()).data
    : null;
  const conversation = rated || await openConversation(orgId, customer.id);

  let content = inbound.text;
  const extra: Record<string, unknown> = { payload: inbound.payload ?? (inbound.filename ? { filename: inbound.filename } : null) };
  if (inbound.mediaId) {
    try {
      const media = await storeMedia(wa, orgId, conversation.id, inbound, raw.id);
      extra.media_path = media.path;
      extra.media_mime = media.mime;
      if (inbound.type === 'audio') {
        const transcript = await transcribe(media.bytes, media.mime).catch(() => '');
        if (transcript) { content = transcript; extra.payload = { transcript: true }; }
      }
    } catch (error) {
      await logAiEvent(orgId, 'webhook_error', { conversationId: conversation.id, error: `Media: ${(error as Error).message}` });
    }
  }

  await admin.from('messages').insert({
    org_id: orgId, conversation_id: conversation.id, content, direction: 'inbound', sender_type: 'customer',
    message_type: inbound.type, wa_message_id: raw.id, sent_at: new Date(Number(raw.timestamp) * 1000 || Date.now()).toISOString(), ...extra,
  });
  await emitEvent(orgId, 'message.received', { conversation_id: conversation.id, customer_id: customer.id, phone: customer.phone, content, type: inbound.type });

  // Customers replying to a broadcast count as "replied" for campaign stats.
  const { data: recipients } = await admin.from('broadcast_recipients').select('id, broadcast_id').eq('customer_id', customer.id)
    .in('status', ['sent', 'delivered', 'read']).gte('updated_at', new Date(Date.now() - 3 * 86400000).toISOString());
  for (const recipient of recipients || []) {
    await admin.from('broadcast_recipients').update({ status: 'replied', updated_at: new Date().toISOString() }).eq('id', recipient.id);
    await refreshBroadcastStats(recipient.broadcast_id);
  }

  const reply = (text: string) => deliver(orgId, conversation.id, customer.phone, { text }, { senderType: 'system' }, wa).catch(() => null);
  const trimmed = content.trim();

  if (OPT_OUT.test(trimmed)) {
    await admin.from('customers').update({ opted_in: false, opted_out_at: new Date().toISOString() }).eq('id', customer.id);
    await reply(ack[lang].optOut);
    return;
  }
  if (OPT_IN.test(trimmed) && customer.opted_in === false) {
    await admin.from('customers').update({ opted_in: true, opted_out_at: null }).eq('id', customer.id);
    await reply(ack[lang].optIn);
    return;
  }

  if (inbound.replyId?.startsWith('csat_')) {
    const score = Number(inbound.replyId.split('_')[1]);
    if (score >= 1 && score <= 5) {
      await admin.from('csat_responses').insert({ org_id: orgId, conversation_id: conversation.id, customer_id: customer.id, score });
      await emitEvent(orgId, 'csat.received', { conversation_id: conversation.id, score });
      await reply(ack[lang].csatThanks);
      return;
    }
  }

  if (inbound.replyId?.startsWith('appt_confirm:')) {
    await admin.from('appointments').update({ status: 'confirmed' }).eq('id', inbound.replyId.split(':')[1]).eq('org_id', orgId);
    await reply(ack[lang].confirmed);
    return;
  }

  if (org?.status === 'suspended' || !settings?.is_live || conversation.ai_paused) return;

  if (!(await withinPlanLimits(orgId))) {
    await createHandoff(orgId, conversation.id, 'AI paused: plan limit reached');
    await reply(settings.fallback_message);
    await logAiEvent(orgId, 'ai_error', { conversationId: conversation.id, error: 'Plan limit reached' });
    return;
  }

  const lower = trimmed.toLowerCase();
  const isVip = (customer.tags || []).some((tag: string) => (settings.vip_tags || []).map((vip: string) => vip.toLowerCase()).includes(tag.toLowerCase()));
  const keyword = settings.handoff_on_human_request && (settings.handoff_keywords || []).find((word: string) => word && lower.includes(word.toLowerCase()));
  if (isVip || keyword || inbound.replyId?.startsWith('appt_reschedule:')) {
    const reason = isVip ? 'VIP customer' : keyword ? `Customer asked for a human ("${keyword}")` : 'Customer wants to reschedule';
    await createHandoff(orgId, conversation.id, reason, isVip ? 'high' : 'normal');
    await reply(settings.fallback_message);
    return;
  }

  if (!isOpen(org.business_hours, org.timezone || 'UTC')) {
    if (settings.after_hours_mode === 'handoff') {
      await createHandoff(orgId, conversation.id, 'Message received outside business hours');
      await reply(settings.after_hours_message);
      return;
    }
    if (settings.after_hours_mode === 'away_message') {
      const { data: lastAway } = await admin.from('messages').select('id').eq('conversation_id', conversation.id).eq('sender_type', 'system')
        .eq('content', settings.after_hours_message).gte('sent_at', new Date(Date.now() - 12 * 3600000).toISOString()).limit(1).maybeSingle();
      if (!lastAway) await reply(settings.after_hours_message);
      return;
    }
  }

  const { data: historyRows } = await admin.from('messages').select('direction, content, message_type')
    .eq('conversation_id', conversation.id).eq('is_internal_note', false).order('sent_at', { ascending: false }).limit(20);
  const history: ChatMessage[] = (historyRows || []).reverse().filter((row) => row.content)
    .map((row) => ({ role: row.direction === 'inbound' ? 'user' : 'assistant', content: row.content }));

  const started = Date.now();
  try {
    const result = await runAgent({ org, settings, customer, conversationId: conversation.id, history });
    const latencyMs = Date.now() - started;
    await admin.from('conversations').update({
      intent: result.intent ?? conversation.intent, sentiment: result.sentiment ?? conversation.sentiment, ai_confidence: result.confidence,
    }).eq('id', conversation.id);
    if (result.unanswered) await recordUnanswered(orgId, conversation.id, result.unanswered);

    const lowConfidence = settings.handoff_on_low_confidence && result.confidence < Number(settings.confidence_threshold ?? 0.55);
    const negative = settings.handoff_on_negative_sentiment && result.sentiment === 'negative';
    if (result.needsHuman || lowConfidence || negative || !result.reply) {
      const reason = result.handoffReason || (lowConfidence ? `Low AI confidence (${Math.round(result.confidence * 100)}%)` : negative ? 'Negative customer sentiment' : 'AI could not answer');
      await createHandoff(orgId, conversation.id, reason, negative ? 'high' : 'normal');
      await deliver(orgId, conversation.id, customer.phone, { text: result.reply && !lowConfidence ? result.reply : settings.fallback_message }, { senderType: 'ai', confidence: result.confidence }, wa);
    } else {
      await deliver(orgId, conversation.id, customer.phone, { text: result.reply }, { senderType: 'ai', confidence: result.confidence, throwOnFailure: false }, wa);
    }
    await logAiEvent(orgId, 'ai_reply', { conversationId: conversation.id, latencyMs, usage: result.usage });
  } catch (error) {
    await logAiEvent(orgId, 'ai_error', { conversationId: conversation.id, latencyMs: Date.now() - started, error: (error as Error).message });
    await createHandoff(orgId, conversation.id, 'AI error — needs a human');
    await reply(settings.fallback_message);
  }
}

async function processPayload(payload: Record<string, any>) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const { data: account } = await admin.from('whatsapp_accounts').select('org_id').eq('phone_number_id', phoneNumberId).eq('status', 'connected').maybeSingle();
      if (!account) continue;
      await admin.from('whatsapp_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('phone_number_id', phoneNumberId);
      await logAiEvent(account.org_id, 'webhook');
      const wa = await getWhatsApp(account.org_id);
      for (const status of value.statuses || []) await handleStatus(status);
      for (const message of value.messages || []) {
        try { await processMessage(wa, value, message); } catch (error) {
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
