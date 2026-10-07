import { HttpError, env, requireEnv } from './http.ts';
import { admin, getSecret } from './supabase.ts';

export const PAYMENT_PROVIDERS = ['stripe', 'paymob', 'tap'] as const;
type Provider = typeof PAYMENT_PROVIDERS[number];

type Order = { id: string; org_id: string; total: number; currency: string; items: { name: string; quantity: number; price: number }[]; customers?: { full_name?: string; phone?: string; email?: string } | null };

const webhookUrl = (provider: Provider, orgId: string) => `${requireEnv('SUPABASE_URL')}/functions/v1/payment-webhook?provider=${provider}&org=${orgId}`;
const returnUrl = () => env('PAYMENT_RETURN_URL', env('APP_URL', 'https://autexa.app'));
const minorUnits = (amount: number, currency: string) => Math.round(amount * (['KWD', 'BHD', 'OMR', 'JOD'].includes(currency.toUpperCase()) ? 1000 : 100));

export async function defaultPaymentProvider(orgId: string): Promise<Provider | null> {
  const { data } = await admin.from('integrations').select('provider, config').eq('org_id', orgId).eq('status', 'connected').in('provider', PAYMENT_PROVIDERS as unknown as string[]);
  if (!data?.length) return null;
  return ((data.find((row) => (row.config as { default?: boolean })?.default) || data[0]).provider) as Provider;
}

async function stripeLink(order: Order) {
  const secret = await getSecret<{ secret_key?: string }>(order.org_id, 'stripe');
  if (!secret?.secret_key) throw new HttpError(400, 'Stripe is not connected');
  const form = new URLSearchParams({
    mode: 'payment',
    success_url: `${returnUrl()}?payment=success`,
    cancel_url: `${returnUrl()}?payment=cancelled`,
    'metadata[order_id]': order.id,
    'metadata[org_id]': order.org_id,
    'payment_intent_data[metadata][order_id]': order.id,
  });
  order.items.forEach((item, index) => {
    form.set(`line_items[${index}][quantity]`, String(item.quantity));
    form.set(`line_items[${index}][price_data][currency]`, order.currency.toLowerCase());
    form.set(`line_items[${index}][price_data][unit_amount]`, String(minorUnits(item.price, order.currency)));
    form.set(`line_items[${index}][price_data][product_data][name]`, item.name);
  });
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${secret.secret_key}` }, body: form });
  const data = await response.json();
  if (!response.ok) throw new HttpError(400, `Stripe: ${data.error?.message}`);
  return { url: data.url as string, reference: data.id as string };
}

async function paymobLink(order: Order) {
  const secret = await getSecret<{ secret_key?: string; public_key?: string; integration_id?: string; base_url?: string }>(order.org_id, 'paymob');
  if (!secret?.secret_key || !secret.public_key || !secret.integration_id) throw new HttpError(400, 'Paymob is not fully configured');
  const base = secret.base_url || 'https://accept.paymob.com';
  const [firstName, ...rest] = (order.customers?.full_name || 'Customer').split(' ');
  const response = await fetch(`${base}/v1/intention/`, {
    method: 'POST',
    headers: { Authorization: `Token ${secret.secret_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: minorUnits(order.total, order.currency),
      currency: order.currency,
      payment_methods: secret.integration_id.split(',').map((id) => Number(id.trim())),
      items: order.items.map((item) => ({ name: item.name.slice(0, 50), amount: minorUnits(item.price, order.currency), quantity: item.quantity })),
      billing_data: { first_name: firstName || 'Customer', last_name: rest.join(' ') || '-', phone_number: order.customers?.phone || '+0000000000', email: order.customers?.email || 'na@autexa.app' },
      special_reference: order.id,
      notification_url: webhookUrl('paymob', order.org_id),
      redirection_url: returnUrl(),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new HttpError(400, `Paymob: ${JSON.stringify(data).slice(0, 200)}`);
  return { url: `${base}/unifiedcheckout/?publicKey=${secret.public_key}&clientSecret=${data.client_secret}`, reference: String(data.id) };
}

async function tapLink(order: Order) {
  const secret = await getSecret<{ secret_key?: string }>(order.org_id, 'tap');
  if (!secret?.secret_key) throw new HttpError(400, 'Tap is not connected');
  const phone = (order.customers?.phone || '').replace(/[^\d]/g, '');
  const response = await fetch('https://api.tap.company/v2/charges', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret.secret_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: order.total,
      currency: order.currency,
      customer: { first_name: order.customers?.full_name || 'Customer', ...(phone ? { phone: { country_code: phone.slice(0, 3), number: phone.slice(3) } } : {}) },
      source: { id: 'src_all' },
      reference: { order: order.id },
      metadata: { order_id: order.id, org_id: order.org_id },
      redirect: { url: returnUrl() },
      post: { url: webhookUrl('tap', order.org_id) },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new HttpError(400, `Tap: ${data.errors?.[0]?.description || response.status}`);
  return { url: data.transaction?.url as string, reference: data.id as string };
}

export async function createPaymentLink(orderId: string, provider?: Provider | null) {
  const { data: order } = await admin.from('orders').select('*, customers(full_name, phone, email)').eq('id', orderId).single();
  if (!order) throw new HttpError(404, 'Order not found');
  const chosen = provider || await defaultPaymentProvider(order.org_id);
  if (!chosen) throw new HttpError(400, 'No payment provider is connected (Stripe, Paymob or Tap)');
  const link = chosen === 'stripe' ? await stripeLink(order) : chosen === 'paymob' ? await paymobLink(order) : await tapLink(order);
  await admin.from('orders').update({ payment_provider: chosen, payment_link: link.url, payment_ref: link.reference }).eq('id', order.id);
  return { ...link, provider: chosen };
}

// Re-fetches the payment from the provider (never trusts the webhook body) and returns the paid order id, if any.
export async function verifyPayment(provider: Provider, orgId: string, payload: Record<string, any>): Promise<string | null> {
  if (provider === 'stripe') {
    const secret = await getSecret<{ secret_key?: string }>(orgId, 'stripe');
    const sessionId = payload?.data?.object?.object === 'checkout.session' ? payload.data.object.id : null;
    if (!secret?.secret_key || !sessionId) return null;
    const session = await (await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${secret.secret_key}` } })).json();
    return session.payment_status === 'paid' && session.metadata?.org_id === orgId ? session.metadata.order_id : null;
  }
  if (provider === 'tap') {
    const secret = await getSecret<{ secret_key?: string }>(orgId, 'tap');
    if (!secret?.secret_key || !payload?.id) return null;
    const charge = await (await fetch(`https://api.tap.company/v2/charges/${payload.id}`, { headers: { Authorization: `Bearer ${secret.secret_key}` } })).json();
    return charge.status === 'CAPTURED' && charge.metadata?.org_id === orgId ? charge.metadata.order_id : null;
  }
  const secret = await getSecret<{ api_key?: string; base_url?: string }>(orgId, 'paymob');
  const transactionId = payload?.obj?.id;
  if (!secret?.api_key || !transactionId) return null;
  const base = secret.base_url || 'https://accept.paymob.com';
  const auth = await (await fetch(`${base}/api/auth/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: secret.api_key }) })).json();
  const transaction = await (await fetch(`${base}/api/acceptance/transactions/${transactionId}`, { headers: { Authorization: `Bearer ${auth.token}` } })).json();
  if (!transaction.success || transaction.pending) return null;
  const reference = transaction.order?.merchant_order_id || transaction.special_reference || payload.obj?.order?.merchant_order_id;
  const { data: order } = await admin.from('orders').select('id').eq('id', reference).eq('org_id', orgId).maybeSingle();
  return order?.id ?? null;
}
