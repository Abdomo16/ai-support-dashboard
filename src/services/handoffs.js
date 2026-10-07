import { db, query } from './supabaseClient.js';
import { orgId, workspace } from './workspace.js';

const select = 'select=id,status,reason,reason_detail,priority,requested_at,claimed_at,resolved_at,claimed_by,conversation_id,profiles:claimed_by(full_name,email),conversations(id,last_message_preview,customers(full_name,phone,tags))';

export const getHandoffs = (status) => query('human_handoffs', `${select}&org_id=eq.${orgId()}${status && status !== 'all' ? `&status=eq.${status}` : ''}&order=requested_at.desc&limit=200`);

export const countPendingHandoffs = async () => (await query('human_handoffs', `select=id&org_id=eq.${orgId()}&status=eq.pending&limit=500`)).length;

export const claimHandoff = (id) => db.update('human_handoffs', `id=eq.${id}`, { status: 'claimed', claimed_by: workspace.user.id });

export async function resolveHandoff(handoff, { handBackToAi = false } = {}) {
  await db.update('human_handoffs', `id=eq.${handoff.id}`, { status: 'resolved' });
  if (handBackToAi && handoff.conversation_id) await db.update('conversations', `id=eq.${handoff.conversation_id}`, { ai_paused: false });
}

export const createHandoff = (conversationId, reason) => db.insert('human_handoffs', { org_id: orgId(), conversation_id: conversationId, reason, status: 'pending' });
