import { HttpError, env, json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { stripe } from '../_shared/stripe.ts';

type Body = { org_id: string; action: 'checkout' | 'portal'; plan_id?: string; return_url?: string };

function safeReturnUrl(value?: string) {
  const appUrl = env('APP_URL');
  if (!value) return `${appUrl}#/billing`;
  if (appUrl && !value.startsWith(appUrl) && !/^http:\/\/localhost(:\d+)?\//.test(value)) throw new HttpError(400, 'Invalid return URL');
  return value;
}

serve(async (request) => {
  const body = await readJson<Body>(request);
  const { user } = await requireRole(request, body.org_id, 'owner');
  if (!env('STRIPE_SECRET_KEY')) throw new HttpError(400, 'Online billing is not configured yet. Contact support to change your plan.');
  const returnUrl = safeReturnUrl(body.return_url);
  const [org, subscription] = await Promise.all([
    admin.from('organizations').select('id, name').eq('id', body.org_id).single().then((result) => must(result)),
    admin.from('subscriptions').select('*').eq('org_id', body.org_id).maybeSingle().then((result) => result.data),
  ]);

  let customerId = subscription?.stripe_customer_id as string | undefined;
  if (!customerId) {
    const customer = await stripe('customers', { name: org.name, email: user.email || '', 'metadata[org_id]': org.id });
    customerId = customer.id;
    await admin.from('subscriptions').upsert({ org_id: org.id, stripe_customer_id: customerId, updated_at: new Date().toISOString() }, { onConflict: 'org_id' });
  }

  if (body.action === 'portal') {
    const session = await stripe('billing_portal/sessions', { customer: customerId!, return_url: returnUrl });
    return json({ url: session.url });
  }

  if (body.action === 'checkout') {
    const plan = must(await admin.from('plans').select('*').eq('id', body.plan_id).eq('is_public', true).maybeSingle(), 'Plan not found');
    if (!plan.stripe_price_id) throw new HttpError(400, 'This plan is not available for online checkout yet');
    if (subscription?.stripe_subscription_id && subscription.status !== 'canceled') {
      // Existing subscribers change plans in the customer portal (handles proration).
      const session = await stripe('billing_portal/sessions', { customer: customerId!, return_url: returnUrl });
      return json({ url: session.url });
    }
    const session = await stripe('checkout/sessions', {
      mode: 'subscription',
      customer: customerId!,
      'line_items[0][price]': plan.stripe_price_id,
      'line_items[0][quantity]': '1',
      success_url: `${returnUrl.split('?')[0]}?checkout=success`,
      cancel_url: `${returnUrl.split('?')[0]}?checkout=cancelled`,
      client_reference_id: org.id,
      'metadata[org_id]': org.id,
      'metadata[plan_id]': plan.id,
      'subscription_data[metadata][org_id]': org.id,
      'subscription_data[metadata][plan_id]': plan.id,
      allow_promotion_codes: 'true',
    });
    return json({ url: session.url });
  }

  throw new HttpError(400, 'Unknown action');
});
