import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { PAYMENT_PROVIDERS, createPaymentLink } from '../_shared/payments.ts';
import { deliver, isWindowOpen, openConversation } from '../_shared/messaging.ts';

type Body = { org_id: string; order_id: string; provider?: string; send?: boolean };

serve(async (request) => {
  const body = await readJson<Body>(request);
  const { user } = await requireRole(request, body.org_id, 'agent');
  const order = must(await admin.from('orders').select('id, org_id, status, total, currency, customer_id, conversation_id, customers(full_name, phone)')
    .eq('id', body.order_id).eq('org_id', body.org_id).maybeSingle(), 'Order not found');
  if (order.status !== 'pending') throw new HttpError(400, 'Only pending orders can be paid');
  if (body.provider && !(PAYMENT_PROVIDERS as readonly string[]).includes(body.provider)) throw new HttpError(400, 'Unknown payment provider');
  const link = await createPaymentLink(order.id, body.provider as typeof PAYMENT_PROVIDERS[number] | undefined);

  let sent = false;
  const customer = order.customers as { full_name?: string; phone?: string } | null;
  if (body.send && customer?.phone && order.customer_id) {
    let conversation = order.conversation_id ? (await admin.from('conversations').select('*').eq('id', order.conversation_id).maybeSingle()).data : null;
    if (!conversation || conversation.status === 'resolved') conversation = await openConversation(body.org_id, order.customer_id);
    if (!isWindowOpen(conversation)) throw new HttpError(400, 'The WhatsApp 24h window is closed. Copy the link and send it with a template instead.');
    const { data: org } = await admin.from('organizations').select('locale').eq('id', body.org_id).single();
    const amount = `${Number(order.total).toFixed(2)} ${order.currency}`;
    const text = org?.locale === 'ar' ? `رابط الدفع لطلبك (${amount}):\n${link.url}` : `Here is your payment link (${amount}):\n${link.url}`;
    await deliver(body.org_id, conversation.id, customer.phone, { text }, { senderType: 'agent', sentBy: user.id });
    sent = true;
  }
  return json({ ...link, sent });
});
