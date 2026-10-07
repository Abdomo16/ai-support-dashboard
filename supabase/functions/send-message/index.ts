import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { deliver, ensureCustomer, isWindowOpen, openConversation } from '../_shared/messaging.ts';

type Body = {
  org_id: string;
  conversation_id?: string;
  customer_id?: string;
  phone?: string;
  name?: string;
  text?: string;
  media_path?: string;
  media_mime?: string;
  template?: { id: string; variables?: string[] };
};

serve(async (request) => {
  const body = await readJson<Body>(request);
  const { user } = await requireRole(request, body.org_id, 'agent');

  let conversation;
  let customer;
  if (body.conversation_id) {
    conversation = must(await admin.from('conversations').select('*, customers(*)').eq('id', body.conversation_id).eq('org_id', body.org_id).maybeSingle(), 'Conversation not found');
    customer = conversation.customers;
  } else {
    customer = body.customer_id
      ? must(await admin.from('customers').select('*').eq('id', body.customer_id).eq('org_id', body.org_id).maybeSingle(), 'Customer not found')
      : await ensureCustomer(body.org_id, body.phone || '', body.name);
    conversation = await openConversation(body.org_id, customer.id);
  }
  if (!customer?.phone) throw new HttpError(400, 'This customer has no WhatsApp number');

  if (!body.template && !isWindowOpen(conversation)) {
    throw new HttpError(400, 'The 24-hour WhatsApp window is closed. Send an approved template instead.');
  }
  if (body.template && customer.opted_in === false) {
    const { data: template } = await admin.from('whatsapp_templates').select('category').eq('id', body.template.id).maybeSingle();
    if (template?.category === 'MARKETING') throw new HttpError(400, 'This customer opted out of marketing messages');
  }

  const message = await deliver(body.org_id, conversation.id, customer.phone, {
    text: body.text,
    mediaPath: body.media_path,
    mediaMime: body.media_mime,
    template: body.template,
  }, { senderType: 'agent', sentBy: user.id });

  // A human replying takes the conversation over from the AI.
  if (!body.template) {
    await admin.from('conversations').update({ ai_paused: true, is_ai_handled: false, assigned_to: conversation.assigned_to || user.id }).eq('id', conversation.id);
  }
  return json({ message, conversation_id: conversation.id });
});
