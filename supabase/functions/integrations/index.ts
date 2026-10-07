import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { admin, getIntegration, getSecret, must, requireRole, setSecret, upsertIntegration } from '../_shared/supabase.ts';
import { emitEvent } from '../_shared/events.ts';
import { PAYMENT_PROVIDERS } from '../_shared/payments.ts';
import { assertPublicUrl } from '../_shared/text.ts';

type Body = { org_id: string; action: 'connect' | 'test' | 'set_default'; provider: string; config?: Record<string, any>; secret?: Record<string, string> };

const clean = (value: unknown) => String(value ?? '').trim();

function publicUrl(value: string) {
  try { assertPublicUrl(value); } catch (error) { throw new HttpError(400, (error as Error).message || 'Invalid URL'); }
}

// Validates credentials against the provider before anything is stored.
async function verify(provider: string, config: Record<string, any>, secret: Record<string, string>) {
  if (provider === 'shopify') {
    const shop = clean(config.shop_domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[\w-]+\.myshopify\.com$/.test(shop)) throw new HttpError(400, 'Use your store domain, e.g. mystore.myshopify.com');
    const response = await fetch(`https://${shop}/admin/api/2024-10/shop.json`, { headers: { 'X-Shopify-Access-Token': clean(secret.access_token) } });
    if (!response.ok) throw new HttpError(400, `Shopify rejected the access token (${response.status})`);
    const data = await response.json();
    return { config: { shop_domain: shop, shop_name: data.shop?.name, currency: data.shop?.currency } };
  }
  if (provider === 'woocommerce') {
    const site = clean(config.site_url).replace(/\/$/, '');
    publicUrl(site);
    const response = await fetch(`${site}/wp-json/wc/v3/system_status`, { headers: { Authorization: `Basic ${btoa(`${clean(secret.consumer_key)}:${clean(secret.consumer_secret)}`)}` } });
    if (!response.ok) throw new HttpError(400, `WooCommerce rejected the API keys (${response.status})`);
    return { config: { site_url: site } };
  }
  if (provider === 'webhook' || provider === 'google_sheets') {
    const url = clean(config.url);
    publicUrl(url);
    return { config: { url, events: Array.isArray(config.events) ? config.events : [] } };
  }
  if (provider === 'stripe') {
    const response = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${clean(secret.secret_key)}` } });
    if (!response.ok) throw new HttpError(400, 'Stripe rejected the secret key');
    return { config: { mode: clean(secret.secret_key).startsWith('sk_live') ? 'live' : 'test' } };
  }
  if (provider === 'tap') {
    const response = await fetch('https://api.tap.company/v2/charges/list', {
      method: 'POST', headers: { Authorization: `Bearer ${clean(secret.secret_key)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1 }),
    });
    if (response.status === 401) throw new HttpError(400, 'Tap rejected the secret key');
    return { config: { mode: clean(secret.secret_key).startsWith('sk_live') ? 'live' : 'test' } };
  }
  if (provider === 'paymob') {
    if (!secret.secret_key || !secret.public_key || !secret.integration_id || !secret.api_key) throw new HttpError(400, 'Paymob needs the API key, secret key, public key and integration IDs');
    const base = clean(secret.base_url) || 'https://accept.paymob.com';
    const response = await fetch(`${base}/api/auth/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: clean(secret.api_key) }) });
    if (!response.ok) throw new HttpError(400, 'Paymob rejected the API key');
    return { config: { base_url: base } };
  }
  throw new HttpError(400, `Unsupported provider: ${provider}`);
}

serve(async (request) => {
  const body = await readJson<Body>(request);
  await requireRole(request, body.org_id, 'admin');
  const provider = clean(body.provider);

  if (body.action === 'connect') {
    const secret = Object.fromEntries(Object.entries(body.secret || {}).map(([key, value]) => [key, clean(value)]).filter(([, value]) => value));
    const existing = await getIntegration(body.org_id, provider);
    const stored = existing ? (await getSecret<Record<string, string>>(body.org_id, provider)) || {} : {};
    const { config } = await verify(provider, body.config || {}, { ...stored, ...secret });
    const isPayment = (PAYMENT_PROVIDERS as readonly string[]).includes(provider);
    if (isPayment) {
      const { count } = await admin.from('integrations').select('id', { count: 'exact', head: true }).eq('org_id', body.org_id).eq('status', 'connected')
        .in('provider', PAYMENT_PROVIDERS as unknown as string[]).neq('provider', provider);
      (config as Record<string, unknown>).default = (existing?.config as { default?: boolean })?.default ?? !count;
    }
    if (provider === 'webhook' && !secret.signing_secret && !stored.signing_secret) {
      secret.signing_secret = [...crypto.getRandomValues(new Uint8Array(24))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    if (Object.keys(secret).length) await setSecret(body.org_id, provider, secret);
    await upsertIntegration(body.org_id, provider, config);
    return json({ ok: true, config, signing_secret: provider === 'webhook' ? secret.signing_secret : undefined });
  }

  if (body.action === 'test') {
    await emitEvent(body.org_id, 'message.received', { test: true, content: 'Test event from Autexa', phone: '+10000000000' });
    return json({ ok: true });
  }

  if (body.action === 'set_default') {
    if (!(PAYMENT_PROVIDERS as readonly string[]).includes(provider)) throw new HttpError(400, 'Not a payment provider');
    const { data: rows } = await admin.from('integrations').select('provider, config').eq('org_id', body.org_id).in('provider', PAYMENT_PROVIDERS as unknown as string[]);
    for (const row of rows || []) {
      must(await admin.from('integrations').update({ config: { ...(row.config as object), default: row.provider === provider } }).eq('org_id', body.org_id).eq('provider', row.provider));
    }
    return json({ ok: true });
  }

  throw new HttpError(400, 'Unknown action');
});
