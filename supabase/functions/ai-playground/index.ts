import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { type ChatMessage, logAiEvent } from '../_shared/ai.ts';
import { runAgent } from '../_shared/agent.ts';

type Body = { org_id: string; messages: { role: 'user' | 'assistant'; content: string }[]; overrides?: Record<string, unknown> };

serve(async (request) => {
  const body = await readJson<Body>(request);
  await requireRole(request, body.org_id, 'agent');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'messages are required');
  const org = must(await admin.from('organizations').select('*').eq('id', body.org_id).single());
  const settings = { ...(must(await admin.from('ai_settings').select('*').eq('org_id', body.org_id).maybeSingle()) || {}), ...(body.overrides || {}) };
  const history: ChatMessage[] = body.messages.slice(-20).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content).slice(0, 4000) }));
  const started = Date.now();
  const result = await runAgent({ org, settings, history, dryRun: true });
  await logAiEvent(body.org_id, 'playground', { latencyMs: Date.now() - started, usage: result.usage });
  return json({ ...result, latency_ms: Date.now() - started });
});
