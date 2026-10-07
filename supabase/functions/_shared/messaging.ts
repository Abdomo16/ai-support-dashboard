import { HttpError, env } from './http.ts';
import { admin, must } from './supabase.ts';
import { emitEvent } from './events.ts';
import {
  type WhatsApp, getWhatsApp, mediaKind, mediaMessage, renderTemplateBody, sendWhatsApp, templateMessage, textMessage,
} from './whatsapp.ts';

export const normalizePhone = (phone: string) => {
  const digits = String(phone || '').replace(/[^\d]/g, '').replace(/^00/, '');
  if (digits.length < 7) throw new HttpError(400, 'A valid phone number with country code is required');
  return `+${digits}`;
};

export async function ensureCustomer(orgId: string, phone: string, name?: string | null) {
  const normalized = normalizePhone(phone);
  const { data: existing } = await admin.from('customers').select('*').eq('org_id', orgId)
    .in('phone', [normalized, normalized.slice(1)]).limit(1).maybeSingle();
  if (existing) {
    if (!existing.full_name && name) await admin.from('customers').update({ full_name: name }).eq('id', existing.id);
    return { ...existing, full_name: existing.full_name || name || null };
  }
  const customer = must(await admin.from('customers').insert({ org_id: orgId, phone: normalized, full_name: name || null }).select().single());
  await emitEvent(orgId, 'customer.created', { customer_id: customer.id, phone: normalized, name });
  return customer;
}

export async function openConversation(orgId: string, customerId: string) {
  const { data: existing } = await admin.from('conversations').select('*').eq('org_id', orgId).eq('customer_id', customerId)
    .neq('status', 'resolved').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existing) return existing;
  return must(await admin.from('conversations').insert({ org_id: orgId, customer_id: customerId, status: 'open', is_ai_handled: true }).select().single());
}

export const isWindowOpen = (conversation: { last_inbound_at?: string | null }) =>
  Boolean(conversation.last_inbound_at) && Date.now() - new Date(conversation.last_inbound_at!).getTime() < 24 * 3600 * 1000;

type Payload = {
  text?: string;
  mediaPath?: string;
  mediaMime?: string;
  template?: { id?: string; name?: string; language?: string; variables?: string[] };
  interactive?: Record<string, unknown>;
};

type Meta = { senderType: 'agent' | 'ai' | 'system'; sentBy?: string | null; confidence?: number | null; throwOnFailure?: boolean };

export async function loadTemplate(orgId: string, template: NonNullable<Payload['template']>) {
  let builder = admin.from('whatsapp_templates').select('*').eq('org_id', orgId);
  builder = template.id ? builder.eq('id', template.id) : builder.eq('name', template.name!).eq('language', template.language || 'en');
  const { data } = await builder.limit(1).maybeSingle();
  if (!data) throw new HttpError(404, 'Template not found');
  if (data.status !== 'approved') throw new HttpError(400, `Template "${data.name}" is not approved by WhatsApp yet`);
  return data;
}

// Sends one WhatsApp message and records it in the conversation. Failed sends are stored with delivery_status=failed.
export async function deliver(orgId: string, conversationId: string, to: string, payload: Payload, meta: Meta, wa?: WhatsApp) {
  const whatsapp = wa || await getWhatsApp(orgId);
  let outgoing: Record<string, unknown>;
  let content = payload.text || '';
  let messageType = 'text';
  let extra: Record<string, unknown> = {};

  if (payload.template) {
    const template = await loadTemplate(orgId, payload.template);
    outgoing = templateMessage(template.name, template.language, payload.template.variables || []);
    content = renderTemplateBody(template.body, payload.template.variables || []);
    messageType = 'template';
    extra = { payload: { template: template.name, variables: payload.template.variables || [] } };
  } else if (payload.mediaPath) {
    if (!payload.mediaPath.startsWith(`${orgId}/`)) throw new HttpError(403, 'Invalid media path');
    const { data: signed } = await admin.storage.from('media').createSignedUrl(payload.mediaPath, 3600);
    if (!signed?.signedUrl) throw new HttpError(400, 'Media file not found');
    messageType = mediaKind(payload.mediaMime);
    const filename = payload.mediaPath.split('/').pop()?.replace(/^\d+-/, '');
    outgoing = mediaMessage(messageType, signed.signedUrl, payload.text, filename);
    extra = { media_path: payload.mediaPath, media_mime: payload.mediaMime, payload: { filename } };
  } else if (payload.interactive) {
    outgoing = payload.interactive;
    messageType = 'interactive';
  } else {
    if (!content.trim()) throw new HttpError(400, 'Message is empty');
    outgoing = textMessage(content);
  }

  let waMessageId: string | null = null;
  let failure: string | null = null;
  try {
    waMessageId = await sendWhatsApp(whatsapp, to, outgoing);
  } catch (error) {
    failure = (error as Error).message;
  }

  const message = must(await admin.from('messages').insert({
    org_id: orgId,
    conversation_id: conversationId,
    content,
    direction: 'outbound',
    is_ai_generated: meta.senderType === 'ai',
    sender_type: meta.senderType,
    sent_by: meta.sentBy ?? null,
    message_type: messageType,
    wa_message_id: waMessageId,
    delivery_status: failure ? 'failed' : 'sent',
    ai_confidence: meta.confidence ?? null,
    ...extra,
  }).select().single());

  if (messageType === 'template' && !failure) {
    await admin.rpc('bump_usage', { p_org: orgId, p_wa_cost: Number(env('WA_TEMPLATE_COST_USD', '0.03')) });
  }
  if (failure && meta.throwOnFailure !== false) throw new HttpError(400, failure);
  if (!failure) await emitEvent(orgId, 'message.sent', { conversation_id: conversationId, message_id: message.id, content, sender_type: meta.senderType });
  return message;
}

export async function createHandoff(orgId: string, conversationId: string, reason: string, priority = 'normal') {
  const { data: pending } = await admin.from('human_handoffs').select('id').eq('conversation_id', conversationId).in('status', ['pending', 'claimed']).limit(1).maybeSingle();
  await admin.from('conversations').update({ ai_paused: true, is_ai_handled: false }).eq('id', conversationId);
  if (pending) return pending;
  const handoff = must(await admin.from('human_handoffs').insert({ org_id: orgId, conversation_id: conversationId, reason, priority, status: 'pending' }).select().single());
  await emitEvent(orgId, 'handoff.requested', { conversation_id: conversationId, reason, priority });
  return handoff;
}
