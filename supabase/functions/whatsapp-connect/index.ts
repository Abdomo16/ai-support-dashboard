import { HttpError, env, json, readJson, requireEnv, serve } from '../_shared/http.ts';
import { admin, must, requireRole, setSecret, upsertIntegration } from '../_shared/supabase.ts';
import { GRAPH_URL, graph } from '../_shared/whatsapp.ts';

type Body = {
  org_id: string;
  action: 'config' | 'embedded' | 'manual' | 'disconnect';
  code?: string;
  phone_number_id?: string;
  waba_id?: string;
  access_token?: string;
  pin?: string;
  account_id?: string;
};

async function numberLimit(orgId: string) {
  const { data } = await admin.from('subscriptions').select('plans(limits)').eq('org_id', orgId).maybeSingle();
  return Number((data?.plans as { limits?: { numbers?: number } } | null)?.limits?.numbers ?? 1);
}

async function connect(orgId: string, phoneNumberId: string, wabaId: string | undefined, token: string) {
  const { data: existing } = await admin.from('whatsapp_accounts').select('org_id').eq('phone_number_id', phoneNumberId).maybeSingle();
  if (existing && existing.org_id !== orgId) throw new HttpError(409, 'This WhatsApp number is already connected to another workspace');
  const { count } = await admin.from('whatsapp_accounts').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'connected').neq('phone_number_id', phoneNumberId);
  if ((count || 0) >= await numberLimit(orgId)) throw new HttpError(402, 'Your plan does not include more WhatsApp numbers. Upgrade to add another.');

  const number = await graph(token, `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
  if (wabaId) {
    // Subscribes our Meta app to the WABA so inbound messages reach the webhook.
    await graph(token, `${wabaId}/subscribed_apps`, {}).catch(() => null);
  }
  await setSecret(orgId, 'whatsapp', { access_token: token });
  const account = must(await admin.from('whatsapp_accounts').upsert({
    org_id: orgId,
    phone_number_id: phoneNumberId,
    waba_id: wabaId || null,
    display_phone: number.display_phone_number,
    verified_name: number.verified_name,
    status: 'connected',
  }, { onConflict: 'phone_number_id' }).select().single());
  await upsertIntegration(orgId, 'whatsapp', { phone_number_id: phoneNumberId, waba_id: wabaId || null, display_phone: number.display_phone_number });
  return account;
}

serve(async (request) => {
  const body = await readJson<Body>(request);
  await requireRole(request, body.org_id, 'admin');

  if (body.action === 'config') {
    return json({
      app_id: env('META_APP_ID'),
      config_id: env('META_CONFIG_ID'),
      graph_version: env('WHATSAPP_GRAPH_VERSION', 'v21.0'),
      webhook_url: `${requireEnv('SUPABASE_URL')}/functions/v1/whatsapp-webhook`,
      verify_token_set: Boolean(env('WHATSAPP_VERIFY_TOKEN')),
    });
  }

  if (body.action === 'embedded') {
    if (!body.code || !body.phone_number_id || !body.waba_id) throw new HttpError(400, 'Embedded signup did not return the number details');
    const params = new URLSearchParams({ client_id: requireEnv('META_APP_ID'), client_secret: requireEnv('META_APP_SECRET'), code: body.code });
    const response = await fetch(`${GRAPH_URL}/oauth/access_token?${params}`);
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new HttpError(400, data.error?.message || 'Could not exchange the Meta authorization code');
    // Numbers created through Embedded Signup must be registered for Cloud API before they can send.
    const pin = body.pin && /^\d{6}$/.test(body.pin) ? body.pin : String(Math.floor(100000 + Math.random() * 900000));
    await graph(data.access_token, `${body.phone_number_id}/register`, { messaging_product: 'whatsapp', pin }).catch(() => null);
    return json({ account: await connect(body.org_id, body.phone_number_id, body.waba_id, data.access_token) });
  }

  if (body.action === 'manual') {
    if (!body.phone_number_id || !body.access_token) throw new HttpError(400, 'Phone number ID and access token are required');
    return json({ account: await connect(body.org_id, body.phone_number_id.trim(), body.waba_id?.trim(), body.access_token.trim()) });
  }

  if (body.action === 'disconnect') {
    must(await admin.from('whatsapp_accounts').update({ status: 'disconnected' }).eq('org_id', body.org_id).eq('id', body.account_id));
    const { count } = await admin.from('whatsapp_accounts').select('id', { count: 'exact', head: true }).eq('org_id', body.org_id).eq('status', 'connected');
    if (!count) {
      await admin.from('integrations').update({ status: 'disconnected' }).eq('org_id', body.org_id).eq('provider', 'whatsapp');
      await admin.from('integration_secrets').delete().eq('org_id', body.org_id).eq('provider', 'whatsapp');
    }
    return json({ ok: true });
  }

  throw new HttpError(400, 'Unknown action');
});
