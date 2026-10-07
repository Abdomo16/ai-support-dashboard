import { db, invokeFunction, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const listBroadcasts = () => query('broadcasts', `select=*,whatsapp_templates(name,language,category)&org_id=eq.${orgId()}&order=created_at.desc&limit=100`);

export const getBroadcast = async (id) => (await query('broadcasts', `select=*,whatsapp_templates(*)&id=eq.${id}`))[0] || null;

export const getRecipients = (broadcastId) => query('broadcast_recipients', `select=status,error,updated_at,customers(full_name,phone)&broadcast_id=eq.${broadcastId}&order=updated_at.desc&limit=500`);

export async function saveBroadcast({ id, ...values }) {
  const rows = id ? await db.update('broadcasts', `id=eq.${id}`, values) : await db.insert('broadcasts', { org_id: orgId(), ...values });
  return rows[0];
}

export const deleteBroadcast = (id) => db.remove('broadcasts', `id=eq.${id}`);
export const sendBroadcastNow = (id) => invokeFunction('broadcast-send', { org_id: orgId(), broadcast_id: id });
export const estimateAudience = (segment) => invokeFunction('broadcast-send', { org_id: orgId(), action: 'estimate', segment });
