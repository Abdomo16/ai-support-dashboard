import { admin, getIntegration, getSecret } from './supabase.ts';

type OrderStatus = { source: string; reference: string; status: string; total?: string; currency?: string; fulfillment?: string | null; tracking?: string | null; created_at?: string };

async function shopifyLookup(orgId: string, reference: string): Promise<OrderStatus | null> {
  const integration = await getIntegration(orgId, 'shopify');
  const secret = await getSecret<{ access_token?: string }>(orgId, 'shopify');
  const shop = (integration?.config as { shop_domain?: string })?.shop_domain;
  if (!shop || !secret?.access_token) return null;
  const name = reference.startsWith('#') ? reference : `#${reference}`;
  const response = await fetch(`https://${shop}/admin/api/2024-10/orders.json?status=any&name=${encodeURIComponent(name)}&fields=name,financial_status,fulfillment_status,total_price,currency,created_at,fulfillments`, {
    headers: { 'X-Shopify-Access-Token': secret.access_token },
  });
  if (!response.ok) return null;
  const order = (await response.json()).orders?.[0];
  if (!order) return null;
  return {
    source: 'shopify', reference: order.name, status: order.financial_status, total: order.total_price, currency: order.currency,
    fulfillment: order.fulfillment_status, tracking: order.fulfillments?.[0]?.tracking_url || order.fulfillments?.[0]?.tracking_number || null, created_at: order.created_at,
  };
}

async function wooLookup(orgId: string, reference: string): Promise<OrderStatus | null> {
  const integration = await getIntegration(orgId, 'woocommerce');
  const secret = await getSecret<{ consumer_key?: string; consumer_secret?: string }>(orgId, 'woocommerce');
  const site = (integration?.config as { site_url?: string })?.site_url;
  const id = reference.replace(/[^\d]/g, '');
  if (!site || !secret?.consumer_key || !id) return null;
  const response = await fetch(`${site.replace(/\/$/, '')}/wp-json/wc/v3/orders/${id}`, {
    headers: { Authorization: `Basic ${btoa(`${secret.consumer_key}:${secret.consumer_secret}`)}` },
  });
  if (!response.ok) return null;
  const order = await response.json();
  return { source: 'woocommerce', reference: String(order.number || order.id), status: order.status, total: order.total, currency: order.currency, created_at: order.date_created };
}

// Looks an order up locally first (Autexa orders), then in the connected store.
export async function lookupOrder(orgId: string, reference: string, customerId?: string): Promise<OrderStatus | { found: false }> {
  const cleaned = reference.trim().replace(/^#/, '');
  const local = admin.from('orders').select('id, status, total, currency, created_at, external_id, customer_id').eq('org_id', orgId);
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned);
  const { data: order } = await (isUuid ? local.eq('id', cleaned) : local.eq('external_id', cleaned)).limit(1).maybeSingle();
  if (order && (!customerId || !order.customer_id || order.customer_id === customerId)) {
    return { source: 'autexa', reference: order.external_id || order.id.slice(0, 8), status: order.status, total: String(order.total), currency: order.currency, created_at: order.created_at };
  }
  return (await shopifyLookup(orgId, cleaned)) || (await wooLookup(orgId, cleaned)) || { found: false };
}
