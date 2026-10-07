import { db, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const listCustomers = (limit = 500) => query('customers', `select=id,full_name,phone,email,tags,opted_in,last_seen_at,created_at,conversations(count)&org_id=eq.${orgId()}&order=last_seen_at.desc.nullslast&limit=${limit}`);

export async function getCustomer(id) {
  const [customer] = await query('customers', `select=*&id=eq.${id}&org_id=eq.${orgId()}`);
  if (!customer) return null;
  const [conversations, appointments, orders, csat] = await Promise.all([
    query('conversations', `select=id,status,last_message_at,last_message_preview,summary,intent,sentiment&customer_id=eq.${id}&order=last_message_at.desc.nullslast`),
    query('appointments', `select=id,starts_at,status,created_by_ai,services(name),team_members(full_name)&customer_id=eq.${id}&order=starts_at.desc`),
    query('orders', `select=id,total,currency,status,created_at&customer_id=eq.${id}&order=created_at.desc`),
    query('csat_responses', `select=score,comment,created_at&customer_id=eq.${id}&order=created_at.desc`),
  ]);
  return { ...customer, conversations, appointments, orders, csat };
}

const clean = (values) => ({
  full_name: values.full_name || null,
  phone: normalizePhone(values.phone),
  email: values.email || null,
  tags: values.tags || [],
  notes: values.notes ?? undefined,
  birthday: values.birthday || null,
  opted_in: values.opted_in ?? true,
  custom_fields: values.custom_fields ?? undefined,
});

export const normalizePhone = (phone) => (phone ? String(phone).replace(/[^\d+]/g, '').replace(/^00/, '+') || null : null);

export const saveCustomer = ({ id, ...values }) => (id
  ? db.update('customers', `id=eq.${id}`, { ...clean(values), opted_out_at: values.opted_in === false ? new Date().toISOString() : null })
  : db.insert('customers', { org_id: orgId(), ...clean(values) }));

export const deleteCustomer = (id) => db.rpc('delete_customer_data', { p_org: orgId(), p_customer: id });

export async function importCustomers(rows) {
  const existing = new Set((await query('customers', `select=phone&org_id=eq.${orgId()}&limit=10000`)).map((row) => row.phone));
  const records = rows
    .map((row) => ({
      org_id: orgId(),
      full_name: row.name || row.full_name || null,
      phone: normalizePhone(row.phone || row.mobile || row.whatsapp),
      email: row.email || null,
      tags: (row.tags || '').split(/[;|]/).map((tag) => tag.trim()).filter(Boolean),
      birthday: row.birthday || null,
    }))
    .filter((row) => row.phone && !existing.has(row.phone));
  for (let index = 0; index < records.length; index += 500) await db.insert('customers', records.slice(index, index + 500));
  return { imported: records.length, skipped: rows.length - records.length };
}

export async function exportCustomerData(id) {
  const customer = await getCustomer(id);
  const messages = customer.conversations.length
    ? await query('messages', `select=conversation_id,content,direction,sent_at,message_type&conversation_id=in.(${customer.conversations.map((item) => item.id).join(',')})&is_internal_note=eq.false&order=sent_at`)
    : [];
  return { exported_at: new Date().toISOString(), ...customer, messages };
}

export const allTags = (customers) => [...new Set(customers.flatMap((customer) => customer.tags || []))].sort();

export const fetchAllTags = async () => allTags(await query('customers', `select=tags&org_id=eq.${orgId()}&tags=neq.{}&limit=10000`));
