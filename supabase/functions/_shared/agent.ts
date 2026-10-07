import { type ChatMessage, type Usage, addUsage, chat, embed, emptyUsage } from './ai.ts';
import { admin, must } from './supabase.ts';
import { availableSlots, createBooking } from './booking.ts';
import { lookupOrder } from './commerce.ts';
import { createPaymentLink } from './payments.ts';
import { emitEvent } from './events.ts';
import { INTENTS } from './insights.ts';
import { describeHours, isOpen, localNow } from './time.ts';

export type AgentResult = {
  reply: string;
  confidence: number;
  needsHuman: boolean;
  handoffReason: string | null;
  intent: string | null;
  sentiment: string | null;
  unanswered: string | null;
  sources: string[];
  actions: { tool: string; result: unknown }[];
  usage: Usage;
};

const DIALECTS: Record<string, string> = {
  auto: "the customer's own Arabic dialect",
  gulf: 'Gulf Arabic (Khaleeji)',
  egyptian: 'Egyptian Arabic',
  levantine: 'Levantine Arabic',
  maghrebi: 'Maghrebi Arabic (Darija)',
  msa: 'Modern Standard Arabic (Fusha)',
};

export async function retrieveKnowledge(orgId: string, text: string) {
  if (!text.trim()) return { context: '', sources: [] as string[], usage: emptyUsage() };
  const { vectors, usage } = await embed([text]);
  const { data } = await admin.rpc('match_kb_chunks', { p_org: orgId, p_embedding: JSON.stringify(vectors[0]), p_count: 6 });
  const relevant = ((data || []) as { content: string; similarity: number; article_id: string | null; document_id: string | null }[]).filter((chunk) => chunk.similarity > 0.3);
  const articleIds = [...new Set(relevant.map((chunk) => chunk.article_id).filter(Boolean))] as string[];
  for (const id of articleIds) {
    const { data: article } = await admin.from('knowledge_base_articles').select('usage_count').eq('id', id).single();
    if (article) await admin.from('knowledge_base_articles').update({ usage_count: (article.usage_count || 0) + 1 }).eq('id', id);
  }
  return {
    context: relevant.map((chunk, index) => `[${index + 1}] ${chunk.content}`).join('\n\n'),
    sources: relevant.map((chunk) => chunk.content.slice(0, 120)),
    usage,
  };
}

function toolDefinitions(enabled: string[]) {
  const tools: unknown[] = [];
  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
    tools.push({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  if (enabled.includes('bookings')) {
    fn('check_availability', 'List free appointment slots for a service on a date (YYYY-MM-DD, business local date).', { service_id: { type: 'string' }, date: { type: 'string' } }, ['service_id', 'date']);
    fn('create_booking', 'Book an appointment once the customer confirmed service and exact slot. starts_at must be one of the ISO times returned by check_availability.', {
      service_id: { type: 'string' }, starts_at: { type: 'string' }, team_member_id: { type: 'string' }, notes: { type: 'string' },
    }, ['service_id', 'starts_at']);
  }
  if (enabled.includes('orders')) fn('lookup_order', 'Look up the status of an order by its number/reference.', { reference: { type: 'string' } }, ['reference']);
  if (enabled.includes('payments')) {
    fn('create_payment_link', 'Create an order and a payment link for products from the catalog after the customer confirmed what they want to buy.', {
      items: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } }, required: ['product_id', 'quantity'] } },
    }, ['items']);
  }
  if (enabled.includes('handoff')) fn('request_human', 'Hand the conversation to a human agent.', { reason: { type: 'string' } }, ['reason']);
  return tools;
}

type AgentInput = {
  org: Record<string, any>;
  settings: Record<string, any>;
  customer?: Record<string, any> | null;
  conversationId?: string | null;
  history: ChatMessage[];
  dryRun?: boolean;
};

// Redacts payment cards, emails, IBANs and long ID numbers before text leaves for the AI provider.
export const maskPii = (text: string) => text
  .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card]')
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[iban]')
  .replace(/\b\d{10,12}\b/g, '[id-number]');

export async function runAgent({ org, settings, customer, conversationId, history, dryRun = false }: AgentInput): Promise<AgentResult> {
  const usage = emptyUsage();
  const actions: AgentResult['actions'] = [];
  const enabled: string[] = settings.tools_enabled || [];
  let needsHuman = false;
  let handoffReason: string | null = null;

  const lastCustomerText = history.filter((message) => message.role === 'user').slice(-2).map((message) => message.content).join('\n');
  const knowledge = await retrieveKnowledge(org.id, lastCustomerText);
  addUsage(usage, knowledge.usage);

  const [{ data: services }, { data: products }] = await Promise.all([
    enabled.includes('bookings') ? admin.from('services').select('id, name, duration_minutes, price, currency, description').eq('org_id', org.id).eq('is_active', true).limit(40) : Promise.resolve({ data: [] }),
    enabled.includes('payments') ? admin.from('products').select('id, name, price, currency, description, stock').eq('org_id', org.id).eq('is_active', true).limit(40) : Promise.resolve({ data: [] }),
  ]);

  const timeZone = org.timezone || 'UTC';
  const now = localNow(timeZone);
  const system = [
    `You are ${settings.persona_name || 'Nova'}, the WhatsApp customer-service assistant for "${org.name}"${org.industry ? ` (${org.industry})` : ''}.`,
    `Tone: ${settings.tone || 'friendly'}. Keep replies short and WhatsApp-friendly: plain text, no markdown headings, at most ~6 lines.`,
    `Reply in the language the customer writes in (supported: ${(settings.languages || ['en', 'ar']).join(', ')}). When replying in Arabic use ${DIALECTS[settings.dialect] || DIALECTS.auto}.`,
    `Current local date/time: ${now.day} ${now.time} (${timeZone}, ${now.weekday}). Business hours: ${describeHours(org.business_hours)}. The business is currently ${isOpen(org.business_hours, timeZone) ? 'open' : 'closed'}.`,
    'Only answer from the knowledge, business facts and tool results below. Never invent prices, policies, stock or availability. If you cannot answer, say a team member will follow up, set needs_human=true and put the customer question in unanswered_question.',
    settings.blocked_topics?.length ? `Never discuss: ${settings.blocked_topics.join(', ')}. Politely decline and offer help with something else.` : '',
    settings.system_prompt ? `Business instructions:\n${settings.system_prompt}` : '',
    customer ? `Customer: ${customer.full_name || 'unknown name'}${customer.tags?.length ? `, tags: ${customer.tags.join(', ')}` : ''}.` : '',
    services?.length ? `Services (id | name | minutes | price):\n${services.map((s) => `${s.id} | ${s.name} | ${s.duration_minutes} | ${s.price ?? '-'} ${s.currency}`).join('\n')}` : '',
    products?.length ? `Products (id | name | price | stock):\n${products.map((p) => `${p.id} | ${p.name} | ${p.price} ${p.currency} | ${p.stock ?? 'n/a'}`).join('\n')}` : '',
    `Knowledge:\n---\n${knowledge.context || '(no matching knowledge)'}\n---`,
    `Respond ONLY with JSON: {"reply": string, "confidence": number 0-1 (how sure you are the reply is correct and grounded), "needs_human": boolean, "handoff_reason": string|null, "intent": one of ${JSON.stringify(INTENTS)}, "sentiment": "positive"|"neutral"|"negative" (the customer's mood), "unanswered_question": string|null}`,
  ].filter(Boolean).join('\n\n');

  const masked = org.settings?.pii_masking ? history.map((message) => ({ ...message, content: maskPii(String(message.content)) })) : history;
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...masked.slice(-20)];
  const tools = toolDefinitions(enabled);

  const runTool = async (name: string, args: Record<string, any>) => {
    switch (name) {
      case 'check_availability':
        return availableSlots(org.id, args.service_id, args.date, timeZone);
      case 'create_booking':
        if (dryRun || !customer) return { booked: true, simulated: true, starts_at: args.starts_at };
        return createBooking(org.id, { customerId: customer.id, conversationId: conversationId ?? undefined, serviceId: args.service_id, startsAt: args.starts_at, teamMemberId: args.team_member_id, notes: args.notes });
      case 'lookup_order':
        return lookupOrder(org.id, String(args.reference || ''), customer?.id);
      case 'create_payment_link': {
        const lines = (args.items || []).map((item: { product_id: string; quantity: number }) => {
          const product = products?.find((entry) => entry.id === item.product_id);
          return product ? { product_id: product.id, name: product.name, price: Number(product.price), quantity: Math.max(1, Number(item.quantity) || 1), currency: product.currency } : null;
        }).filter(Boolean);
        if (!lines.length) return { error: 'Unknown products' };
        const total = lines.reduce((sum: number, line: any) => sum + line.price * line.quantity, 0);
        if (dryRun || !customer) return { url: 'https://pay.example.com/simulated', total, currency: lines[0].currency, simulated: true };
        const order = must(await admin.from('orders').insert({
          org_id: org.id, customer_id: customer.id, conversation_id: conversationId, items: lines, total, currency: lines[0].currency, created_by_ai: true,
        }).select('id').single());
        await emitEvent(org.id, 'order.created', { order_id: order.id, total, currency: lines[0].currency });
        const link = await createPaymentLink(order.id);
        return { order_id: order.id, url: link.url, total, currency: lines[0].currency };
      }
      case 'request_human':
        needsHuman = true;
        handoffReason = args.reason || 'Requested by AI';
        return { ok: true };
      default:
        return { error: `Unknown tool ${name}` };
    }
  };

  let parsed: Record<string, any> = {};
  for (let step = 0; step < 5; step += 1) {
    const { message, usage: stepUsage } = await chat({ model: settings.model || 'gpt-4o-mini', temperature: Number(settings.temperature ?? 0.3), messages, tools, json: true });
    addUsage(usage, stepUsage);
    const calls = (message.tool_calls || []) as { id: string; function: { name: string; arguments: string } }[];
    if (!calls.length) {
      try { parsed = JSON.parse(message.content || '{}'); } catch { parsed = { reply: message.content, confidence: 0.5 }; }
      break;
    }
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let result: unknown;
      try { result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}')); } catch (error) { result = { error: (error as Error).message }; }
      actions.push({ tool: call.function.name, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return {
    reply: String(parsed.reply || '').trim(),
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
    needsHuman: needsHuman || Boolean(parsed.needs_human),
    handoffReason: handoffReason || parsed.handoff_reason || null,
    intent: INTENTS.includes(parsed.intent) ? parsed.intent : null,
    sentiment: ['positive', 'neutral', 'negative'].includes(parsed.sentiment) ? parsed.sentiment : null,
    unanswered: parsed.unanswered_question || null,
    sources: knowledge.sources,
    actions,
    usage,
  };
}

export async function recordUnanswered(orgId: string, conversationId: string | null, question: string) {
  const { data: existing } = await admin.from('unanswered_questions').select('id, occurrences').eq('org_id', orgId).eq('status', 'open').ilike('question', question.slice(0, 200).replace(/[%_\\]/g, '\\$&')).limit(1).maybeSingle();
  if (existing) await admin.from('unanswered_questions').update({ occurrences: existing.occurrences + 1, last_asked_at: new Date().toISOString() }).eq('id', existing.id);
  else await admin.from('unanswered_questions').insert({ org_id: orgId, conversation_id: conversationId, question: question.slice(0, 500) });
}
