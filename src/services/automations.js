import { db, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const TRIGGERS = ['no_reply_24h', 'booking_created', 'booking_completed', 'inquiry_abandoned', 'birthday', 'new_customer', 'conversation_resolved'];
export const ACTIONS = ['send_template', 'send_text', 'add_tag', 'remove_tag', 'create_handoff', 'emit_webhook'];

export const listAutomations = () => query('automations', `select=*&org_id=eq.${orgId()}&order=created_at.desc`);

export const listRuns = (automationId) => query('automation_runs', `select=*,customers(full_name,phone)&automation_id=eq.${automationId}&order=created_at.desc&limit=100`);

export async function saveAutomation({ id, ...values }) {
  const rows = id ? await db.update('automations', `id=eq.${id}`, values) : await db.insert('automations', { org_id: orgId(), ...values });
  return rows[0];
}

export const deleteAutomation = (id) => db.remove('automations', `id=eq.${id}`);

// Custom n8n jobs built for this workspace by the platform team (read-only for the workspace).
export const listScheduledTasks = () => query('automation_jobs', `select=*&org_id=eq.${orgId()}&order=name`);

export const RECIPES = [
  { key: 'review', trigger: 'booking_completed', delay_minutes: 120, actions: [{ type: 'send_template', template_id: '', variables: ['{first_name}'] }, { type: 'add_tag', tag: 'review-requested' }] },
  { key: 'followUp', trigger: 'no_reply_24h', delay_minutes: 0, actions: [{ type: 'send_template', template_id: '', variables: ['{first_name}'] }] },
  { key: 'abandoned', trigger: 'inquiry_abandoned', delay_minutes: 240, actions: [{ type: 'send_template', template_id: '', variables: ['{first_name}'] }] },
  { key: 'birthday', trigger: 'birthday', delay_minutes: 600, actions: [{ type: 'send_template', template_id: '', variables: ['{first_name}'] }] },
  { key: 'welcome', trigger: 'new_customer', delay_minutes: 5, actions: [{ type: 'add_tag', tag: 'new' }, { type: 'emit_webhook' }] },
];
