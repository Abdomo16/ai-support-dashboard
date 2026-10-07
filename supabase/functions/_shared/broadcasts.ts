import { HttpError } from './http.ts';
import { admin, must } from './supabase.ts';
import { deliver, openConversation } from './messaging.ts';
import { getWhatsApp } from './whatsapp.ts';

export async function refreshBroadcastStats(broadcastId: string) {
  const { data: rows } = await admin.from('broadcast_recipients').select('status').eq('broadcast_id', broadcastId);
  const count = (statuses: string[]) => (rows || []).filter((row) => statuses.includes(row.status)).length;
  await admin.from('broadcasts').update({
    sent: count(['sent', 'delivered', 'read', 'replied']),
    delivered: count(['delivered', 'read', 'replied']),
    read: count(['read', 'replied']),
    replied: count(['replied']),
    failed: count(['failed']),
  }).eq('id', broadcastId);
}

// Resolves "{{name}}"-style variable mappings per customer; literal values pass through unchanged.
export function resolveVariable(mapping: string, customer: Record<string, any>) {
  return String(mapping || '')
    .replace(/\{name\}/g, customer.full_name || '')
    .replace(/\{first_name\}/g, (customer.full_name || '').split(' ')[0] || '')
    .replace(/\{phone\}/g, customer.phone || '')
    .replace(/\{field:([\w-]+)\}/g, (_, key) => String(customer.custom_fields?.[key] ?? ''));
}

export async function segmentCustomers(orgId: string, segment: { tags?: string[]; opted_in_only?: boolean; marketing?: boolean }) {
  let query = admin.from('customers').select('id, full_name, phone, custom_fields, tags, opted_in').eq('org_id', orgId).not('phone', 'is', null).limit(10000);
  if (segment.tags?.length) query = query.overlaps('tags', segment.tags);
  if (segment.opted_in_only !== false || segment.marketing) query = query.eq('opted_in', true);
  const { data } = await query;
  return data || [];
}

export async function sendBroadcast(orgId: string, broadcastId: string) {
  const { data: claimed } = await admin.from('broadcasts').update({ status: 'sending' }).eq('id', broadcastId).eq('org_id', orgId)
    .in('status', ['draft', 'scheduled']).select('*, whatsapp_templates(*)');
  const broadcast = claimed?.[0];
  if (!broadcast) throw new HttpError(409, 'This broadcast was already sent or is sending');
  const template = broadcast.whatsapp_templates;
  try {
    if (!template || template.status !== 'approved') throw new HttpError(400, 'The broadcast template is not approved');
    const wa = await getWhatsApp(orgId);
    const customers = await segmentCustomers(orgId, { ...broadcast.segment, marketing: template.category === 'MARKETING' });
    must(await admin.from('broadcast_recipients').upsert(
      customers.map((customer) => ({ org_id: orgId, broadcast_id: broadcastId, customer_id: customer.id, status: 'queued' })),
      { onConflict: 'broadcast_id,customer_id', ignoreDuplicates: true },
    ));
    await admin.from('broadcasts').update({ total: customers.length }).eq('id', broadcastId);
    for (const customer of customers) {
      const variables = ((broadcast.variables || []) as string[]).map((mapping) => resolveVariable(mapping, customer));
      try {
        const conversation = await openConversation(orgId, customer.id);
        const message = await deliver(orgId, conversation.id, customer.phone, { template: { id: template.id, variables } }, { senderType: 'system' }, wa);
        await admin.from('broadcast_recipients').update({ status: 'sent', wa_message_id: message.wa_message_id, updated_at: new Date().toISOString() })
          .eq('broadcast_id', broadcastId).eq('customer_id', customer.id);
      } catch (error) {
        await admin.from('broadcast_recipients').update({ status: 'failed', error: (error as Error).message.slice(0, 300), updated_at: new Date().toISOString() })
          .eq('broadcast_id', broadcastId).eq('customer_id', customer.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await refreshBroadcastStats(broadcastId);
    await admin.from('broadcasts').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', broadcastId);
    return { total: customers.length };
  } catch (error) {
    await admin.from('broadcasts').update({ status: 'failed' }).eq('id', broadcastId);
    throw error;
  }
}
