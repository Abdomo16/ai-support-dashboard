// Public REST API for tenants (Zapier/Make/custom code). Deploy with --no-verify-jwt; authenticated by the x-api-key header.
import { HttpError, json, readJson, serve, sha256Hex } from '../_shared/http.ts';
import { admin, must } from '../_shared/supabase.ts';
import { createBooking } from '../_shared/booking.ts';
import { deliver, ensureCustomer, isWindowOpen, normalizePhone, openConversation } from '../_shared/messaging.ts';

type Body = Record<string, any> & { action: string };

async function authenticate(request: Request) {
  const key = request.headers.get('x-api-key') || '';
  if (!key.startsWith('atx_')) throw new HttpError(401, 'Missing or invalid x-api-key header');
  const { data: apiKey } = await admin.from('api_keys').select('id, org_id, organizations(status)').eq('key_hash', await sha256Hex(key)).is('revoked_at', null).maybeSingle();
  if (!apiKey) throw new HttpError(401, 'Invalid API key');
  if ((apiKey.organizations as { status?: string } | null)?.status === 'suspended') throw new HttpError(403, 'Workspace suspended');
  await admin.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', apiKey.id);
  return apiKey.org_id as string;
}

serve(async (request) => {
  const orgId = await authenticate(request);
  const body = request.method === 'GET' ? { action: new URL(request.url).searchParams.get('action') || 'list_conversations' } as Body : await readJson<Body>(request);

  switch (body.action) {
    case 'send_message': {
      const customer = await ensureCustomer(orgId, body.phone);
      const conversation = await openConversation(orgId, customer.id);
      if (!isWindowOpen(conversation)) throw new HttpError(400, 'The 24h WhatsApp window is closed for this customer. Use send_template.');
      const message = await deliver(orgId, conversation.id, customer.phone, { text: String(body.text || '') }, { senderType: 'system' });
      return json({ message_id: message.id, conversation_id: conversation.id });
    }
    case 'send_template': {
      const customer = await ensureCustomer(orgId, body.phone);
      const { data: template } = await admin.from('whatsapp_templates').select('category').eq('org_id', orgId).eq('name', body.template).limit(1).maybeSingle();
      if (template?.category === 'MARKETING' && customer.opted_in === false) throw new HttpError(400, 'Customer opted out of marketing messages');
      const conversation = await openConversation(orgId, customer.id);
      const message = await deliver(orgId, conversation.id, customer.phone, {
        template: { name: body.template, language: body.language || 'en', variables: (body.variables || []).map(String) },
      }, { senderType: 'system' });
      return json({ message_id: message.id, conversation_id: conversation.id });
    }
    case 'upsert_customer': {
      const customer = await ensureCustomer(orgId, body.phone, body.full_name);
      const patch: Record<string, unknown> = {};
      if (body.full_name) patch.full_name = String(body.full_name);
      if (body.email) patch.email = String(body.email);
      if (Array.isArray(body.tags)) patch.tags = [...new Set([...(customer.tags || []), ...body.tags.map(String)])];
      if (body.custom_fields && typeof body.custom_fields === 'object') patch.custom_fields = { ...(customer.custom_fields || {}), ...body.custom_fields };
      if (body.birthday) patch.birthday = String(body.birthday);
      const updated = Object.keys(patch).length ? must(await admin.from('customers').update(patch).eq('id', customer.id).select().single()) : customer;
      return json({ customer: updated });
    }
    case 'get_customer': {
      const phone = normalizePhone(body.phone);
      const { data } = await admin.from('customers').select('*').eq('org_id', orgId).in('phone', [phone, phone.slice(1)]).maybeSingle();
      if (!data) throw new HttpError(404, 'Customer not found');
      return json({ customer: data });
    }
    case 'create_booking': {
      const customer = await ensureCustomer(orgId, body.phone, body.full_name);
      const booking = await createBooking(orgId, { customerId: customer.id, serviceId: body.service_id, startsAt: body.starts_at, teamMemberId: body.team_member_id, notes: body.notes });
      return json({ booking });
    }
    case 'list_conversations': {
      let query = admin.from('conversations').select('id, status, intent, sentiment, summary, last_message_at, last_message_preview, customers(full_name, phone)')
        .eq('org_id', orgId).order('last_message_at', { ascending: false, nullsFirst: false }).limit(Math.min(Number(body.limit) || 50, 200));
      if (body.status) query = query.eq('status', String(body.status));
      return json({ conversations: must(await query) });
    }
    default:
      throw new HttpError(400, 'Unknown action. Use send_message, send_template, upsert_customer, get_customer, create_booking or list_conversations.');
  }
});
