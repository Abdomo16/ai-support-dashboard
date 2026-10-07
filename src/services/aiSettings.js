import { db, invokeFunction, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export async function getAiSettings() {
  const [row] = await query('ai_settings', `select=*&org_id=eq.${orgId()}`);
  return row || null;
}

export const saveAiSettings = (patch) => db.insert('ai_settings', { org_id: orgId(), ...patch }, { upsert: true, onConflict: 'org_id' });

export const runPlayground = (messages, overrides = {}) => invokeFunction('ai-playground', { org_id: orgId(), messages, overrides });

export const getAiReplies = ({ feedback, lowConfidence } = {}) => {
  let filter = `&org_id=eq.${orgId()}&is_ai_generated=eq.true`;
  if (feedback === 'bad') filter += '&feedback=eq.-1';
  if (feedback === 'good') filter += '&feedback=eq.1';
  if (lowConfidence) filter += `&ai_confidence=lt.${lowConfidence}`;
  return query('messages', `select=id,content,ai_confidence,feedback,feedback_note,sent_at,conversation_id${filter}&order=sent_at.desc&limit=100`);
};

export const getAiEvents = (hours = 24) => query('ai_events', `select=kind,latency_ms,tokens_in,tokens_out,cost_usd,error,created_at&org_id=eq.${orgId()}&created_at=gte.${new Date(Date.now() - hours * 3600000).toISOString()}&order=created_at.desc&limit=1000`);
