import { HttpError, env } from './http.ts';
import { admin, getSecret } from './supabase.ts';

export const GRAPH_URL = `https://graph.facebook.com/${env('WHATSAPP_GRAPH_VERSION', 'v21.0')}`;

export type Provider = 'meta' | 'waha' | '360dialog' | 'twilio' | 'ultramsg';
export type WhatsApp = {
  account: { id: string; org_id: string; phone_number_id: string; waba_id: string | null; provider: Provider; config: Record<string, any> };
  token: string;
  secret: Record<string, any>;
};
type Outgoing = Record<string, unknown>;

export async function graph(token: string, path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${GRAPH_URL}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status >= 500 ? 502 : 400, data?.error?.error_user_msg || data?.error?.message || `WhatsApp API error ${response.status}`);
  return data;
}

// Meta keeps its token under the legacy 'whatsapp' secret; other providers use 'whatsapp:{account id}'.
export async function getWhatsApp(orgId: string, accountId?: string): Promise<WhatsApp> {
  let query = admin.from('whatsapp_accounts').select('id, org_id, phone_number_id, waba_id, provider, config')
    .eq('org_id', orgId).eq('status', 'connected');
  query = accountId ? query.eq('id', accountId) : query.order('created_at');
  const { data: account } = await query.limit(1).maybeSingle();
  if (!account) throw new HttpError(400, 'WhatsApp is not connected for this workspace.');
  const provider = (account.provider || 'meta') as Provider;
  const secret = (await getSecret<Record<string, any>>(orgId, provider === 'meta' ? 'whatsapp' : `whatsapp:${account.id}`)) || {};
  const token = secret.access_token || secret.api_key || secret.token || secret.auth_token || '';
  if (!token) throw new HttpError(400, 'WhatsApp credentials are missing for this workspace.');
  return { account: { ...account, provider, config: account.config || {} }, token, secret };
}

// Non-Meta providers only send plain text, so rich messages degrade to readable text.
function asText(message: Outgoing): string {
  const m = message as Record<string, any>;
  if (m.type === 'text') return m.text?.body || '';
  if (m.type === 'interactive') {
    const i = m.interactive || {};
    const options = i.type === 'button'
      ? (i.action?.buttons || []).map((b: any) => b.reply?.title)
      : (i.action?.sections || []).flatMap((s: any) => s.rows || []).map((r: any) => r.title);
    return [i.body?.text, ...options.map((title: string, index: number) => `${index + 1}. ${title}`)].filter(Boolean).join('\n');
  }
  const media = m[m.type];
  if (media?.link) return [media.caption, media.link].filter(Boolean).join('\n');
  return '';
}

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(400, data?.message || data?.error?.message || data?.error || `WhatsApp provider error ${response.status}`);
  return data;
}

export async function sendWhatsApp(wa: WhatsApp, to: string, message: Outgoing): Promise<string | null> {
  const digits = to.replace(/[^\d]/g, '');
  const config = wa.account.config;
  switch (wa.account.provider) {
    case 'waha': {
      const base = String(config.base_url || '').replace(/\/$/, '');
      const data = await postJson(`${base}/api/sendText`, { session: config.session || 'default', chatId: `${digits}@c.us`, text: asText(message) }, { 'X-Api-Key': wa.token });
      return data?.id?._serialized || data?.id || null;
    }
    case '360dialog': {
      const data = await postJson('https://waba-v2.360dialog.io/messages',
        { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits, ...message }, { 'D360-API-KEY': wa.token });
      return data.messages?.[0]?.id ?? null;
    }
    case 'twilio': {
      const sid = wa.secret.account_sid || config.account_sid;
      const form = new URLSearchParams({ From: `whatsapp:+${String(config.from || '').replace(/[^\d]/g, '')}`, To: `whatsapp:+${digits}`, Body: asText(message) });
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(`${sid}:${wa.token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new HttpError(400, data?.message || `Twilio error ${response.status}`);
      return data.sid ?? null;
    }
    case 'ultramsg': {
      const form = new URLSearchParams({ token: wa.token, to: `+${digits}`, body: asText(message) });
      const response = await fetch(`https://api.ultramsg.com/${config.instance_id}/messages/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new HttpError(400, String(data.error || `UltraMsg error ${response.status}`));
      return data.id ? String(data.id) : null;
    }
    default: {
      const data = await graph(wa.token, `${wa.account.phone_number_id}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: digits,
        ...message,
      });
      return data.messages?.[0]?.id ?? null;
    }
  }
}

export const textMessage = (body: string): Outgoing => ({ type: 'text', text: { body: body.slice(0, 4096), preview_url: true } });

export const mediaKind = (mime = '') =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'document';

export function mediaMessage(kind: string, link: string, caption?: string, filename?: string): Outgoing {
  const media: Record<string, string> = { link };
  if (caption && kind !== 'audio') media.caption = caption;
  if (kind === 'document' && filename) media.filename = filename;
  return { type: kind, [kind]: media };
}

export function templateMessage(name: string, language: string, variables: string[] = []): Outgoing {
  return {
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: variables.length ? [{ type: 'body', parameters: variables.map((text) => ({ type: 'text', text: String(text) })) }] : [],
    },
  };
}

export function buttonsMessage(body: string, buttons: { id: string; title: string }[]): Outgoing {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.slice(0, 3).map((button) => ({ type: 'reply', reply: { id: button.id, title: button.title.slice(0, 20) } })) },
    },
  };
}

export function listMessage(body: string, buttonLabel: string, rows: { id: string; title: string; description?: string }[]): Outgoing {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      action: { button: buttonLabel.slice(0, 20), sections: [{ title: buttonLabel.slice(0, 24), rows: rows.slice(0, 10).map((row) => ({ ...row, title: row.title.slice(0, 24) })) }] },
    },
  };
}

export async function downloadMedia(wa: WhatsApp, mediaId: string) {
  const meta = await graph(wa.token, mediaId);
  const response = await fetch(meta.url, { headers: { Authorization: `Bearer ${wa.token}` } });
  if (!response.ok) throw new Error(`Media download failed (${response.status})`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), mime: (meta.mime_type as string) || 'application/octet-stream' };
}

export function renderTemplateBody(body: string, variables: string[] = []) {
  return body.replace(/\{\{(\d+)\}\}/g, (_, index) => variables[Number(index) - 1] ?? '');
}
