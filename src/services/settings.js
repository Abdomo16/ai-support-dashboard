import { db, publicFileUrl, query, removeFile, updatePassword, uploadFile } from './supabaseClient.js';
import { orgId, refreshOrganization, workspace } from './workspace.js';

export async function updateOrganization(patch) {
  await db.update('organizations', `id=eq.${orgId()}`, patch);
  return refreshOrganization();
}

export const updateOrgSettings = (patch) => updateOrganization({ settings: { ...(workspace.org.settings || {}), ...patch } });

export async function uploadLogo(file) {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file');
  if (file.size > 1024 * 1024) throw new Error('Logo must be smaller than 1 MB');
  const extension = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${orgId()}/logo-${Date.now()}.${extension}`;
  await uploadFile('branding', path, file);
  const previous = workspace.org.logo_url?.split('/branding/')[1];
  if (previous) removeFile('branding', previous).catch(() => {});
  return publicFileUrl('branding', path);
}

export const updateProfile = async (patch) => {
  await db.update('profiles', `id=eq.${workspace.user.id}`, patch);
  workspace.profile = { ...workspace.profile, ...patch };
};
export const changePassword = (password) => updatePassword(password);

export const listApiKeys = () => query('api_keys', `select=id,name,prefix,last_used_at,revoked_at,created_at&org_id=eq.${orgId()}&order=created_at.desc`);
export const createApiKey = (name) => db.rpc('create_api_key', { p_org: orgId(), p_name: name });
export const revokeApiKey = (id) => db.update('api_keys', `id=eq.${id}`, { revoked_at: new Date().toISOString() });

export const listAuditLog = ({ before, entity } = {}) => query('audit_log', `select=id,action,entity,entity_id,details,created_at,profiles(full_name,email)&org_id=eq.${orgId()}${entity ? `&entity=eq.${entity}` : ''}${before ? `&id=lt.${before}` : ''}&order=id.desc&limit=50`);

async function pageAll(table, select) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await query(table, `select=${select}&org_id=eq.${orgId()}&order=created_at&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

export async function exportWorkspaceData() {
  const tables = ['customers', 'conversations', 'appointments', 'services', 'orders', 'products', 'knowledge_base_articles', 'csat_responses', 'broadcasts', 'automations'];
  const result = { exported_at: new Date().toISOString(), organization: workspace.org };
  for (const table of tables) result[table] = await pageAll(table, '*');
  const messages = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await query('messages', `select=conversation_id,direction,sender_type,content,message_type,sent_at&org_id=eq.${orgId()}&is_internal_note=eq.false&order=sent_at&limit=1000&offset=${offset}`);
    messages.push(...page);
    if (page.length < 1000) break;
  }
  result.messages = messages;
  return result;
}

export const deleteWorkspace = () => db.remove('organizations', `id=eq.${orgId()}`);
