import { chatJson, logAiEvent } from './ai.ts';
import { admin } from './supabase.ts';

export const INTENTS = ['booking', 'pricing', 'purchase', 'order_status', 'complaint', 'support', 'general', 'other'];

export async function generateInsights(orgId: string, conversationId: string) {
  const { data: messages } = await admin.from('messages').select('direction, content, is_ai_generated')
    .eq('conversation_id', conversationId).eq('is_internal_note', false).order('sent_at', { ascending: false }).limit(60);
  const transcript = (messages || []).reverse()
    .map((message) => `${message.direction === 'inbound' ? 'Customer' : message.is_ai_generated ? 'AI' : 'Agent'}: ${message.content || '[media]'}`)
    .join('\n');
  if (!transcript) return { summary: null, intent: null, sentiment: null };
  const { data: settings } = await admin.from('ai_settings').select('model').eq('org_id', orgId).maybeSingle();
  const started = Date.now();
  const { data, usage } = await chatJson<{ summary?: string; intent?: string; sentiment?: string }>(
    settings?.model || 'gpt-4o-mini',
    `You analyze WhatsApp customer-service conversations. Reply with JSON: {"summary": "<=2 sentences in the conversation's language", "intent": one of ${JSON.stringify(INTENTS)}, "sentiment": "positive" | "neutral" | "negative"}.`,
    transcript,
  );
  const result = {
    summary: data.summary?.slice(0, 600) || null,
    intent: INTENTS.includes(data.intent || '') ? data.intent! : 'other',
    sentiment: ['positive', 'neutral', 'negative'].includes(data.sentiment || '') ? data.sentiment! : 'neutral',
  };
  await admin.from('conversations').update(result).eq('id', conversationId);
  await logAiEvent(orgId, 'insights', { conversationId, latencyMs: Date.now() - started, usage });
  return result;
}
