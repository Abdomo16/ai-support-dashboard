import { admin } from './supabase.ts';
import { emitEvent } from './events.ts';
import { resolveVariable } from './broadcasts.ts';
import { createHandoff, deliver, isWindowOpen, openConversation } from './messaging.ts';
import { localNow } from './time.ts';
import { logAiEvent } from './ai.ts';

type Automation = {
  id: string; org_id: string; name: string; trigger: string; delay_minutes: number; created_at: string;
  conditions: { tags?: string[]; exclude_tags?: string[]; service_ids?: string[]; intents?: string[] };
  actions: Action[];
};
type Action =
  | { type: 'send_template'; template_id: string; variables?: string[] }
  | { type: 'send_text'; text: string }
  | { type: 'add_tag'; tag: string }
  | { type: 'remove_tag'; tag: string }
  | { type: 'create_handoff'; reason?: string }
  | { type: 'emit_webhook' };

type Candidate = { key: string; customer: Record<string, any>; conversationId?: string | null; context: Record<string, unknown> };

const CUSTOMER = 'customers(id, full_name, phone, tags, opted_in, custom_fields)';
const LOOKBACK_MS = 3 * 86400_000;

// Finds entities that hit the trigger moment (event time + delay) since the automation was created.
async function candidates(automation: Automation, org: Record<string, any>): Promise<Candidate[]> {
  const now = Date.now();
  const due = new Date(now - automation.delay_minutes * 60_000);
  const since = new Date(Math.max(new Date(automation.created_at).getTime(), due.getTime() - LOOKBACK_MS));
  // deno-lint-ignore no-explicit-any
  const range = (builder: any, column: string) => builder.gte(column, since.toISOString()).lte(column, due.toISOString());
  const orgId = automation.org_id;

  switch (automation.trigger) {
    case 'new_customer': {
      const { data } = await range(admin.from('customers').select('id, full_name, phone, tags, opted_in, custom_fields').eq('org_id', orgId), 'created_at').limit(500);
      return (data || []).map((customer: any) => ({ key: `customer:${customer.id}`, customer, context: {} }));
    }
    case 'booking_created':
    case 'booking_completed': {
      const column = automation.trigger === 'booking_created' ? 'created_at' : 'ends_at';
      const statuses = automation.trigger === 'booking_created' ? ['scheduled', 'confirmed'] : ['scheduled', 'confirmed', 'completed'];
      let builder = admin.from('appointments').select(`id, service_id, conversation_id, starts_at, services(name), ${CUSTOMER}`).eq('org_id', orgId).in('status', statuses);
      if (automation.conditions.service_ids?.length) builder = builder.in('service_id', automation.conditions.service_ids);
      const { data } = await range(builder, column).limit(500);
      return (data || []).filter((row: any) => row.customers).map((row: any) => ({
        key: `appointment:${row.id}`, customer: row.customers, conversationId: row.conversation_id, context: { service: row.services?.name || '', starts_at: row.starts_at },
      }));
    }
    case 'conversation_resolved': {
      const { data } = await range(admin.from('conversations').select(`id, intent, ${CUSTOMER}`).eq('org_id', orgId).eq('status', 'resolved'), 'resolved_at').limit(500);
      return (data || []).filter((row: any) => row.customers).map((row: any) => ({ key: `conversation:${row.id}`, customer: row.customers, conversationId: row.id, context: { intent: row.intent } }));
    }
    case 'no_reply_24h': {
      const quietSince = new Date(now - (24 * 60 + automation.delay_minutes) * 60_000);
      const { data } = await admin.from('conversations').select(`id, intent, last_message_at, last_inbound_at, ${CUSTOMER}`).eq('org_id', orgId).eq('status', 'open')
        .lte('last_message_at', quietSince.toISOString()).gte('last_message_at', new Date(Math.max(new Date(automation.created_at).getTime(), quietSince.getTime() - LOOKBACK_MS)).toISOString()).limit(500);
      return (data || []).filter((row: any) => row.customers && (!row.last_inbound_at || row.last_inbound_at < row.last_message_at))
        .map((row: any) => ({ key: `conversation:${row.id}:${row.last_message_at}`, customer: row.customers, conversationId: row.id, context: { intent: row.intent } }));
    }
    case 'inquiry_abandoned': {
      const intents = automation.conditions.intents?.length ? automation.conditions.intents : ['booking', 'pricing', 'purchase'];
      const { data } = await range(admin.from('conversations').select(`id, intent, created_at, last_inbound_at, ${CUSTOMER}`).eq('org_id', orgId).in('intent', intents), 'last_inbound_at').limit(500);
      const rows = (data || []).filter((row: any) => row.customers);
      if (!rows.length) return [];
      const ids = rows.map((row: any) => row.id);
      const [{ data: booked }, { data: ordered }] = await Promise.all([
        admin.from('appointments').select('conversation_id').in('conversation_id', ids),
        admin.from('orders').select('conversation_id').in('conversation_id', ids),
      ]);
      const converted = new Set([...(booked || []), ...(ordered || [])].map((row: any) => row.conversation_id));
      return rows.filter((row: any) => !converted.has(row.id))
        .map((row: any) => ({ key: `conversation:${row.id}`, customer: row.customers, conversationId: row.id, context: { intent: row.intent } }));
    }
    case 'birthday': {
      const today = localNow(org.timezone || 'UTC');
      const monthDay = today.day.slice(5);
      // Run birthday messages once the delay (minutes after local midnight) has passed.
      if (today.minutes < automation.delay_minutes) return [];
      const { data } = await admin.from('customers').select('id, full_name, phone, tags, opted_in, custom_fields, birthday').eq('org_id', orgId).not('birthday', 'is', null).limit(10000);
      return (data || []).filter((customer: any) => String(customer.birthday).slice(5, 10) === monthDay)
        .map((customer: any) => ({ key: `birthday:${customer.id}:${today.day.slice(0, 4)}`, customer, context: {} }));
    }
    default:
      return [];
  }
}

function matches(automation: Automation, candidate: Candidate) {
  const tags = (candidate.customer.tags || []).map((tag: string) => tag.toLowerCase());
  const { tags: include, exclude_tags: exclude } = automation.conditions;
  if (include?.length && !include.some((tag) => tags.includes(tag.toLowerCase()))) return false;
  if (exclude?.length && exclude.some((tag) => tags.includes(tag.toLowerCase()))) return false;
  return Boolean(candidate.customer.phone);
}

async function runActions(automation: Automation, candidate: Candidate) {
  const orgId = automation.org_id;
  const customer = candidate.customer;
  let conversation: Record<string, any> | null = null;
  const conversationFor = async () => {
    if (conversation) return conversation;
    if (candidate.conversationId) {
      const { data } = await admin.from('conversations').select('*').eq('id', candidate.conversationId).maybeSingle();
      if (data && data.status !== 'resolved') conversation = data;
    }
    conversation ||= await openConversation(orgId, customer.id);
    return conversation;
  };

  for (const action of automation.actions || []) {
    if (action.type === 'send_template') {
      const { data: template } = await admin.from('whatsapp_templates').select('category').eq('id', action.template_id).maybeSingle();
      if (template?.category === 'MARKETING' && customer.opted_in === false) continue;
      const target = await conversationFor();
      const variables = (action.variables || []).map((mapping) => resolveVariable(mapping, customer).replace(/\{service\}/g, String(candidate.context.service || '')));
      await deliver(orgId, target.id, customer.phone, { template: { id: action.template_id, variables } }, { senderType: 'system' });
    }
    if (action.type === 'send_text') {
      const target = await conversationFor();
      if (!isWindowOpen(target)) throw new Error('WhatsApp 24h window is closed; use a template action instead');
      await deliver(orgId, target.id, customer.phone, { text: resolveVariable(action.text, customer).replace(/\{service\}/g, String(candidate.context.service || '')) }, { senderType: 'system' });
    }
    if (action.type === 'add_tag' || action.type === 'remove_tag') {
      const tags: string[] = customer.tags || [];
      const next = action.type === 'add_tag' ? [...new Set([...tags, action.tag])] : tags.filter((tag) => tag !== action.tag);
      await admin.from('customers').update({ tags: next }).eq('id', customer.id);
      customer.tags = next;
    }
    if (action.type === 'create_handoff') {
      await createHandoff(orgId, (await conversationFor()).id, action.reason || `Automation: ${automation.name}`);
    }
    if (action.type === 'emit_webhook') {
      await emitEvent(orgId, 'automation.fired', { automation_id: automation.id, automation: automation.name, trigger: automation.trigger, customer_id: customer.id, phone: customer.phone, ...candidate.context });
    }
  }
}

export async function runAutomations() {
  const { data: automations } = await admin.from('automations').select('*, organizations(timezone, status)').eq('is_active', true).limit(1000);
  let fired = 0;
  for (const automation of (automations || []) as (Automation & { organizations: Record<string, any> })[]) {
    if (automation.organizations?.status === 'suspended') continue;
    try {
      const list = (await candidates(automation, automation.organizations || {})).filter((candidate) => matches(automation, candidate));
      let count = 0;
      for (const candidate of list) {
        // The unique (automation_id, dedupe_key) row is the lock that keeps each automation firing once per entity.
        const { data: run, error } = await admin.from('automation_runs').insert({
          org_id: automation.org_id, automation_id: automation.id, dedupe_key: candidate.key, customer_id: candidate.customer.id, status: 'running',
        }).select('id').single();
        if (error || !run) continue;
        try {
          await runActions(automation, candidate);
          await admin.from('automation_runs').update({ status: 'done' }).eq('id', run.id);
          count += 1;
        } catch (actionError) {
          await admin.from('automation_runs').update({ status: 'failed', error: (actionError as Error).message.slice(0, 300) }).eq('id', run.id);
        }
      }
      if (count) {
        const { data: current } = await admin.from('automations').select('run_count').eq('id', automation.id).single();
        await admin.from('automations').update({ run_count: (current?.run_count || 0) + count, last_run_at: new Date().toISOString() }).eq('id', automation.id);
        fired += count;
      }
    } catch (error) {
      await logAiEvent(automation.org_id, 'automation_error', { error: `${automation.name}: ${(error as Error).message}` });
    }
  }
  return { fired };
}
