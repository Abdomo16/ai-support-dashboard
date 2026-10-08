import { db, invokeFunction, query, signedUrls, uploadFile } from './supabaseClient.js';
import { orgId, workspace } from './workspace.js';
import { whatsappProvider } from './integrations.js';

const listColumns = 'id,status,is_ai_handled,ai_paused,assigned_to,last_message_at,last_message_preview,last_inbound_at,intent,sentiment,created_at,customers(id,full_name,phone,tags)';

export async function listConversations(filter = 'all') {
  const filters = {
    all: '',
    open: '&status=eq.open',
    resolved: '&status=eq.resolved',
    mine: `&assigned_to=eq.${workspace.user.id}&status=neq.resolved`,
    unassigned: '&assigned_to=is.null&status=neq.resolved',
    paused: '&ai_paused=eq.true&status=neq.resolved',
  };
  return query('conversations', `select=${listColumns}&org_id=eq.${orgId()}${filters[filter] || ''}&order=last_message_at.desc.nullslast&limit=200`);
}

export async function getConversation(id) {
  const [row] = await query('conversations', `select=*,customers(*),assignee:assigned_to(full_name,email)&id=eq.${id}&org_id=eq.${orgId()}`);
  return row || null;
}

export async function getMessages(conversationId, limit = 300) {
  const rows = await query('messages', `select=*,agent:sent_by(full_name)&conversation_id=eq.${conversationId}&order=sent_at.desc&limit=${limit}`);
  return rows.reverse();
}

export const getMessage = async (id) => (await query('messages', `select=*,agent:sent_by(full_name)&id=eq.${id}`))[0];

export const mediaUrls = (messages) => signedUrls('media', [...new Set(messages.map((message) => message.media_path).filter(Boolean))]);

export const updateConversation = (id, patch) => db.update('conversations', `id=eq.${id}`, patch);

export const takeOver = (id) => updateConversation(id, { ai_paused: true, is_ai_handled: false, assigned_to: workspace.user.id });
export const handBackToAi = (id) => updateConversation(id, { ai_paused: false });

export async function uploadMedia(conversationId, file) {
  const safeName = file.name.replace(/[^\w.-]+/g, '_');
  return uploadFile('media', `${orgId()}/${conversationId}/${Date.now()}-${safeName}`, file);
}

// Numbers linked through WAHA are sent by n8n's outbox workflow on the VM, which picks up queued rows.
export async function sendMessage(payload) {
  if ((await whatsappProvider()) !== 'waha') return invokeFunction('send-message', { org_id: orgId(), ...payload });
  if (payload.template || payload.media_path) throw new Error('Templates and attachments need the WhatsApp Cloud API.');
  const [message] = await db.insert('messages', {
    org_id: orgId(),
    conversation_id: payload.conversation_id,
    content: payload.text,
    direction: 'outbound',
    sender_type: 'agent',
    sent_by: workspace.user.id,
    delivery_status: 'queued',
  });
  await updateConversation(payload.conversation_id, { ai_paused: true });
  return { message };
}

// WAHA numbers only reply to customers who wrote in the last 24 hours (the database enforces the same rule).
export async function startConversation({ customer_id: customerId, phone, text }, replyOnlyMessage) {
  let customer = customerId;
  if (!customer) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 8) throw new Error('Enter the phone number with its country code.');
    const [existing] = await query('customers', `select=id&org_id=eq.${orgId()}&phone=eq.${digits}&limit=1`);
    customer = existing?.id;
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const recent = customer ? await query('conversations', `select=id&org_id=eq.${orgId()}&customer_id=eq.${customer}&last_inbound_at=gt.${since}&limit=1`) : [];
  if (!recent.length) throw new Error(replyOnlyMessage);
  const [open] = await query('conversations', `select=id&org_id=eq.${orgId()}&customer_id=eq.${customer}&status=in.(open,pending,escalated)&order=created_at.desc&limit=1`);
  const conversationId = open?.id || (await db.insert('conversations', { org_id: orgId(), customer_id: customer, status: 'open' }))[0].id;
  await sendMessage({ conversation_id: conversationId, text });
  return { conversation_id: conversationId };
}

export const addNote = (conversationId, content) => db.insert('messages', {
  org_id: orgId(),
  conversation_id: conversationId,
  content,
  direction: 'outbound',
  is_internal_note: true,
  sender_type: 'agent',
  sent_by: workspace.user.id,
});

export const setFeedback = (messageId, feedback, note = null) => db.update('messages', `id=eq.${messageId}`, { feedback, feedback_note: note });

export const requestInsights = (conversationId) => invokeFunction('conversation-insights', { org_id: orgId(), conversation_id: conversationId });

// Free-form replies are allowed within 24 hours of the customer's last message: a Cloud API rule, and our anti-ban rule for WAHA.
export const isWindowOpen = (conversation) =>
  Boolean(conversation?.last_inbound_at) && Date.now() - new Date(conversation.last_inbound_at).getTime() < 24 * 3600 * 1000;
