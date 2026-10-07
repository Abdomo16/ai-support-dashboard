import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { getWhatsApp, graph } from '../_shared/whatsapp.ts';

type Body = { org_id: string; action: 'submit' | 'sync'; template_id?: string };

const STATUS: Record<string, string> = { APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'disabled' };

function components(template: Record<string, any>) {
  const parts: Record<string, unknown>[] = [];
  if (template.header_text) parts.push({ type: 'HEADER', format: 'TEXT', text: template.header_text });
  const variableCount = new Set(String(template.body).match(/\{\{\d+\}\}/g) || []).size;
  parts.push({
    type: 'BODY',
    text: template.body,
    ...(variableCount ? { example: { body_text: [Array.from({ length: variableCount }, (_, index) => `sample${index + 1}`)] } } : {}),
  });
  if (template.footer) parts.push({ type: 'FOOTER', text: template.footer });
  const buttons = (template.buttons || []).filter((button: any) => button?.text).map((button: any) => (
    button.type === 'URL' ? { type: 'URL', text: button.text, url: button.url }
      : button.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: button.text, phone_number: button.phone_number }
        : { type: 'QUICK_REPLY', text: button.text }
  ));
  if (buttons.length) parts.push({ type: 'BUTTONS', buttons });
  return parts;
}

function fromMeta(component: any[]) {
  const find = (type: string) => component.find((part) => part.type === type);
  return {
    header_text: find('HEADER')?.format === 'TEXT' ? find('HEADER').text : null,
    body: find('BODY')?.text || '',
    footer: find('FOOTER')?.text || null,
    buttons: (find('BUTTONS')?.buttons || []).map((button: any) => ({ type: button.type, text: button.text, url: button.url, phone_number: button.phone_number })),
  };
}

serve(async (request) => {
  const body = await readJson<Body>(request);
  await requireRole(request, body.org_id, 'admin');
  const wa = await getWhatsApp(body.org_id);
  if (!wa.account.waba_id) throw new HttpError(400, 'The WhatsApp Business Account ID is missing. Reconnect WhatsApp in Integrations.');

  if (body.action === 'submit') {
    const template = must(await admin.from('whatsapp_templates').select('*').eq('id', body.template_id).eq('org_id', body.org_id).maybeSingle(), 'Template not found');
    if (!/^[a-z0-9_]+$/.test(template.name)) throw new HttpError(400, 'Template names may only contain lowercase letters, numbers and underscores');
    const result = await graph(wa.token, `${wa.account.waba_id}/message_templates`, {
      name: template.name, language: template.language, category: template.category, components: components(template),
    });
    const updated = must(await admin.from('whatsapp_templates').update({
      status: STATUS[result.status] || 'pending', meta_template_id: result.id, rejection_reason: null,
    }).eq('id', template.id).select().single());
    return json({ template: updated });
  }

  if (body.action === 'sync') {
    let next = `${wa.account.waba_id}/message_templates?limit=100&fields=id,name,language,status,category,components,rejected_reason`;
    let synced = 0;
    while (next) {
      const page = await graph(wa.token, next);
      for (const remote of page.data || []) {
        must(await admin.from('whatsapp_templates').upsert({
          org_id: body.org_id,
          name: remote.name,
          language: remote.language,
          category: ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(remote.category) ? remote.category : 'UTILITY',
          status: STATUS[remote.status] || 'pending',
          meta_template_id: remote.id,
          rejection_reason: remote.rejected_reason && remote.rejected_reason !== 'NONE' ? remote.rejected_reason : null,
          ...fromMeta(remote.components || []),
        }, { onConflict: 'org_id,name,language' }));
        synced += 1;
      }
      const after = page.paging?.cursors?.after;
      next = page.paging?.next && after ? `${wa.account.waba_id}/message_templates?limit=100&after=${after}&fields=id,name,language,status,category,components,rejected_reason` : '';
    }
    return json({ synced });
  }

  throw new HttpError(400, 'Unknown action');
});
