import { HttpError, hmacHex, requireEnv, timingSafeEqual } from './http.ts';

// Platform Stripe account (Autexa's own subscriptions), not a tenant's payment integration.
export async function stripe(path: string, params?: Record<string, string>, method = params ? 'POST' : 'GET') {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${requireEnv('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new HttpError(400, `Stripe: ${data.error?.message || response.status}`);
  return data;
}

export async function verifyStripeSignature(body: string, header: string, secret: string, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  const signatures = header.split(',').filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}
