import { db, invokeFunction, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const getTemplates = (status) => query('whatsapp_templates', `select=*&org_id=eq.${orgId()}${status ? `&status=eq.${status}` : ''}&order=created_at.desc`);

export const saveTemplate = ({ id, ...values }) => (id
  ? db.update('whatsapp_templates', `id=eq.${id}`, { ...values, status: 'draft' })
  : db.insert('whatsapp_templates', { org_id: orgId(), ...values }));

export const deleteTemplate = (id) => db.remove('whatsapp_templates', `id=eq.${id}`);
export const submitTemplate = (templateId) => invokeFunction('whatsapp-templates', { org_id: orgId(), action: 'submit', template_id: templateId });
export const syncTemplates = () => invokeFunction('whatsapp-templates', { org_id: orgId(), action: 'sync' });

export const templateVariableCount = (body) => new Set((body || '').match(/\{\{\d+\}\}/g) || []).size;
