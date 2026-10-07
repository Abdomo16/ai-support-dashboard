import { db, query } from './supabaseClient.js';
import { orgId, workspace } from './workspace.js';

export const getCannedResponses = () => query('canned_responses', `select=*&org_id=eq.${orgId()}&order=shortcut`);
export const saveCannedResponse = ({ id, shortcut, title, body }) => (id
  ? db.update('canned_responses', `id=eq.${id}`, { shortcut, title, body })
  : db.insert('canned_responses', { org_id: orgId(), shortcut, title, body, created_by: workspace.user.id }));
export const deleteCannedResponse = (id) => db.remove('canned_responses', `id=eq.${id}`);

export function fillVariables(body, { customer, agent } = {}) {
  const name = customer?.full_name || '';
  return body
    .replace(/\{name\}/g, name)
    .replace(/\{first_name\}/g, name.split(' ')[0] || '')
    .replace(/\{phone\}/g, customer?.phone || '')
    .replace(/\{agent\}/g, agent || workspace.profile?.full_name || '');
}
