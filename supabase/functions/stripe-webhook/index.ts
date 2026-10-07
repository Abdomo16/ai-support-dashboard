// Platform subscription webhooks from Stripe. Deploy with --no-verify-jwt; authenticated by the Stripe signature.
import { json, requireEnv, serve } from '../_shared/http.ts';
import { admin } from '../_shared/supabase.ts';
import { stripe, verifyStripeSignature } from '../_shared/stripe.ts';

const STATUS: Record<string, string> = {
  trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', incomplete: 'past_due',
  canceled: 'canceled', incomplete_expired: 'canceled', paused: 'past_due',
};

async function syncSubscription(subscription: Record<string, any>) {
  const orgId = subscription.metadata?.org_id;
  if (!orgId) return;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const { data: plan } = priceId ? await admin.from('plans').select('id').eq('stripe_price_id', priceId).maybeSingle() : { data: null };
  const status = STATUS[subscription.status] || 'past_due';
  const planId = status === 'canceled' ? 'trial' : plan?.id || subscription.metadata?.plan_id || 'starter';
  const periodEnd = subscription.current_period_end || subscription.items?.data?.[0]?.current_period_end;
  await admin.from('subscriptions').upsert({
    org_id: orgId,
    plan_id: planId,
    status,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'org_id' });
  await admin.from('organizations').update({ plan: planId }).eq('id', orgId);
}

serve(async (request) => {
  const body = await request.text();
  if (!(await verifyStripeSignature(body, request.headers.get('Stripe-Signature') || '', requireEnv('STRIPE_WEBHOOK_SECRET')))) {
    return new Response('Invalid signature', { status: 400 });
  }
  const event = JSON.parse(body);
  const object = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
      if (object.mode === 'subscription' && object.subscription) await syncSubscription(await stripe(`subscriptions/${object.subscription}`));
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      // Re-fetch so out-of-order deliveries always store the latest state.
      await syncSubscription(await stripe(`subscriptions/${object.id}`));
      break;
    case 'invoice.payment_failed':
      if (object.subscription) await syncSubscription(await stripe(`subscriptions/${object.subscription}`));
      break;
    default:
      break;
  }
  return json({ received: true });
});
