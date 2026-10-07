// Payment provider webhooks (Stripe, Paymob, Tap). Deploy with --no-verify-jwt.
// The body is never trusted: verifyPayment() re-fetches the payment from the provider with the workspace's own keys.
import { json, serve } from '../_shared/http.ts';
import { admin } from '../_shared/supabase.ts';
import { PAYMENT_PROVIDERS, verifyPayment } from '../_shared/payments.ts';
import { emitEvent } from '../_shared/events.ts';
import { deliver, isWindowOpen } from '../_shared/messaging.ts';

type Provider = typeof PAYMENT_PROVIDERS[number];

serve(async (request) => {
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider') as Provider;
  const orgId = url.searchParams.get('org') || '';
  if (!(PAYMENT_PROVIDERS as readonly string[]).includes(provider) || !/^[0-9a-f-]{36}$/i.test(orgId)) return json({ error: 'Unknown provider' }, 400);
  if (request.method === 'GET') return json({ ok: true });

  const raw = await request.text();
  let payload: Record<string, any> = {};
  try { payload = JSON.parse(raw || '{}'); } catch { payload = Object.fromEntries(new URLSearchParams(raw)); }

  const orderId = await verifyPayment(provider, orgId, payload);
  if (!orderId) return json({ received: true });

  const { data: updated } = await admin.from('orders').update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', orderId).eq('org_id', orgId).eq('status', 'pending').select('id, total, currency, conversation_id, customers(phone), organizations(locale)');
  const order = updated?.[0];
  if (!order) return json({ received: true });

  await emitEvent(orgId, 'order.paid', { order_id: order.id, total: order.total, currency: order.currency, provider });
  const phone = (order.customers as { phone?: string } | null)?.phone;
  if (order.conversation_id && phone) {
    const { data: conversation } = await admin.from('conversations').select('id, last_inbound_at').eq('id', order.conversation_id).maybeSingle();
    if (conversation && isWindowOpen(conversation)) {
      const arabic = (order.organizations as { locale?: string } | null)?.locale === 'ar';
      const text = arabic ? `تم استلام دفعتك (${Number(order.total).toFixed(2)} ${order.currency}). شكراً لك!` : `Payment received (${Number(order.total).toFixed(2)} ${order.currency}). Thank you!`;
      await deliver(orgId, conversation.id, phone, { text }, { senderType: 'system', throwOnFailure: false });
    }
  }
  return json({ received: true });
});
