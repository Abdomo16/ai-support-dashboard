import { HttpError, env } from './http.ts';
import { admin, getSecret } from './supabase.ts';

export const GRAPH_URL = `https://graph.facebook.com/${env('WHATSAPP_GRAPH_VERSION', 'v21.0')}`;

export type WhatsApp = { account: { id: string; org_id: string; phone_number_id: string; waba_id: string | null }; token: string };
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

export async function getWhatsApp(orgId: string): Promise<WhatsApp> {
  const { data: account } = await admin.from('whatsapp_accounts').select('id, org_id, phone_number_id, waba_id')
    .eq('org_id', orgId).eq('status', 'connected').order('created_at').limit(1).maybeSingle();
  const secret = await getSecret<{ access_token?: string }>(orgId, 'whatsapp');
  if (!account || !secret?.access_token) throw new HttpError(400, 'WhatsApp is not connected for this workspace.');
  return { account, token: secret.access_token };
}

export async function sendWhatsApp(wa: WhatsApp, to: string, message: Outgoing): Promise<string | null> {
  const data = await graph(wa.token, `${wa.account.phone_number_id}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to.replace(/[^\d]/g, ''),
    ...message,
  });
  return data.messages?.[0]?.id ?? null;
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
