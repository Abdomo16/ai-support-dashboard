// Google Calendar OAuth. Deploy with --no-verify-jwt: Google's redirect (GET) carries no Supabase JWT,
// so the callback is authenticated by the HMAC-signed state created in the POST "start" step.
import { HttpError, env, hmacHex, json, readJson, requireEnv, serve, timingSafeEqual } from '../_shared/http.ts';
import { requireRole, setSecret, upsertIntegration } from '../_shared/supabase.ts';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const callbackUrl = () => `${requireEnv('SUPABASE_URL')}/functions/v1/google-oauth`;
const stateKey = () => requireEnv('SUPABASE_SERVICE_ROLE_KEY');

async function signState(payload: Record<string, unknown>) {
  const data = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  return `${data}.${await hmacHex(stateKey(), data)}`;
}

async function readState(state: string) {
  const [data, signature] = state.split('.');
  if (!data || !signature || !timingSafeEqual(signature, await hmacHex(stateKey(), data))) throw new HttpError(400, 'Invalid OAuth state');
  const payload = JSON.parse(atob(data));
  if (payload.exp < Date.now()) throw new HttpError(400, 'The connection link expired. Please try again.');
  return payload as { org: string; return_to: string; calendar_id: string; exp: number };
}

const redirect = (url: string) => new Response(null, { status: 302, headers: { Location: url } });

serve(async (request) => {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const state = await readState(url.searchParams.get('state') || '');
    const back = (status: string) => redirect(`${state.return_to.split('#')[0]}#/integrations?google=${status}`);
    const code = url.searchParams.get('code');
    if (!code) return back('cancelled');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: requireEnv('GOOGLE_CLIENT_ID'), client_secret: requireEnv('GOOGLE_CLIENT_SECRET'), redirect_uri: callbackUrl(), grant_type: 'authorization_code' }),
    });
    const tokens = await response.json();
    if (!response.ok || !tokens.refresh_token) return back('failed');
    await setSecret(state.org, 'google_calendar', { refresh_token: tokens.refresh_token });
    await upsertIntegration(state.org, 'google_calendar', { calendar_id: state.calendar_id || 'primary' });
    return back('connected');
  }

  const body = await readJson<{ org_id: string; return_to: string; calendar_id?: string }>(request);
  await requireRole(request, body.org_id, 'admin');
  if (!env('GOOGLE_CLIENT_ID')) throw new HttpError(400, 'Google Calendar is not configured on the server (GOOGLE_CLIENT_ID).');
  const appUrl = env('APP_URL');
  if (appUrl && !body.return_to.startsWith(appUrl) && !/^http:\/\/localhost(:\d+)?\//.test(body.return_to)) throw new HttpError(400, 'Invalid return URL');
  const state = await signState({ org: body.org_id, return_to: body.return_to, calendar_id: body.calendar_id || 'primary', exp: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_CLIENT_ID'), redirect_uri: callbackUrl(), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});
