import { db, invokeFunction, query, supabaseConfig } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const listIntegrations = () => query('integrations', `select=*&org_id=eq.${orgId()}`);
export const listWhatsAppAccounts = () => query('whatsapp_accounts', `select=*&org_id=eq.${orgId()}&order=created_at`);

export const WHATSAPP_PROVIDERS = ['360dialog', 'twilio', 'ultramsg', 'waha'];

// 'waha' means "text-only, queued for the n8n outbox" and covers every non-Meta provider.
const providerCache = new Map();
export async function whatsappProvider() {
  const id = orgId();
  if (!providerCache.has(id)) {
    providerCache.set(id, query('whatsapp_accounts', `select=provider&org_id=eq.${id}&provider=neq.meta&status=eq.connected&limit=1`)
      .then((rows) => (rows.length ? 'waha' : 'meta'))
      .catch(() => { providerCache.delete(id); return 'meta'; }));
  }
  return providerCache.get(id);
}

export async function connectWhatsAppProvider({ provider, display_phone, name, ...fields }) {
  const secretKeys = { '360dialog': ['api_key'], twilio: ['account_sid', 'auth_token'], ultramsg: ['token'], waha: ['api_key'] }[provider] || [];
  const secret = Object.fromEntries(secretKeys.map((key) => [key, fields[key]]));
  const config = Object.fromEntries(Object.entries(fields).filter(([key, value]) => !secretKeys.includes(key) && value));
  providerCache.delete(orgId());
  return db.rpc('connect_whatsapp_account', { p_org: orgId(), p_provider: provider, p_display_phone: display_phone, p_config: { ...config, name }, p_secret: secret });
}
export async function whatsappInboundUrl(accountId) {
  const key = await db.rpc('whatsapp_webhook_secret', { p_account: accountId });
  return `${supabaseConfig.url}/functions/v1/whatsapp-inbound?account=${accountId}&key=${key}`;
}
export const disconnectWhatsAppProvider = (accountId) => { providerCache.delete(orgId()); return db.rpc('disconnect_whatsapp_account', { p_account: accountId }); };

export const connectIntegration = (provider, { config = {}, secret = {} } = {}) => invokeFunction('integrations', { org_id: orgId(), action: 'connect', provider, config, secret });
export const disconnectIntegration = (provider) => db.rpc('disconnect_integration', { p_org: orgId(), p_provider: provider });
export const sendTestEvent = (provider) => invokeFunction('integrations', { org_id: orgId(), action: 'test', provider });
export const setDefaultPayment = (provider) => invokeFunction('integrations', { org_id: orgId(), action: 'set_default', provider });

export const whatsappConfig = () => invokeFunction('whatsapp-connect', { org_id: orgId(), action: 'config' });
export const connectWhatsAppEmbedded = (payload) => invokeFunction('whatsapp-connect', { org_id: orgId(), action: 'embedded', ...payload });
export const connectWhatsAppManual = (payload) => invokeFunction('whatsapp-connect', { org_id: orgId(), action: 'manual', ...payload });
export const disconnectWhatsAppAccount = (accountId) => invokeFunction('whatsapp-connect', { org_id: orgId(), action: 'disconnect', account_id: accountId });

export const startGoogleOAuth = (calendarId) => invokeFunction('google-oauth', { org_id: orgId(), return_to: `${location.origin}${location.pathname}`, calendar_id: calendarId });

export const publicApiUrl = () => `${supabaseConfig.url}/functions/v1/public-api`;

let sdkPromise = null;
function loadFacebookSdk(appId, version) {
  sdkPromise ||= new Promise((resolve, reject) => {
    window.fbAsyncInit = () => { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version }); resolve(window.FB); };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => { sdkPromise = null; reject(new Error('Could not load the Facebook SDK')); };
    document.head.append(script);
  });
  return sdkPromise;
}

// Meta Embedded Signup: the popup posts the new WABA/number ids via postMessage, and FB.login returns an auth code.
export async function runEmbeddedSignup(config) {
  if (!config.app_id || !config.config_id) throw new Error('Embedded Signup is not configured on the server (META_APP_ID / META_CONFIG_ID).');
  const FB = await loadFacebookSdk(config.app_id, config.graph_version);
  let session = null;
  const onMessage = (event) => {
    if (!/facebook\.com$/.test(new URL(event.origin).hostname)) return;
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data?.type === 'WA_EMBEDDED_SIGNUP' && data.event?.startsWith('FINISH')) session = data.data;
    } catch { /* non-JSON messages from the SDK */ }
  };
  window.addEventListener('message', onMessage);
  try {
    const code = await new Promise((resolve, reject) => FB.login((response) => {
      if (response.authResponse?.code) resolve(response.authResponse.code);
      else reject(new Error('WhatsApp signup was cancelled'));
    }, { config_id: config.config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: '3' } }));
    for (let wait = 0; !session && wait < 20; wait += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!session?.phone_number_id) throw new Error('Signup finished without a phone number. Please try again or use manual setup.');
    return connectWhatsAppEmbedded({ code, phone_number_id: session.phone_number_id, waba_id: session.waba_id });
  } finally {
    window.removeEventListener('message', onMessage);
  }
}
