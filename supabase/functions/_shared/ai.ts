import { HttpError, env } from './http.ts';
import { admin } from './supabase.ts';

// Any OpenAI-compatible endpoint works (OpenAI, Azure OpenAI proxy, OpenRouter, Groq...).
const BASE_URL = env('AI_BASE_URL', 'https://api.openai.com/v1');
const apiKey = () => {
  const key = env('AI_API_KEY') || env('OPENAI_API_KEY');
  if (!key) throw new HttpError(500, 'Missing server configuration: AI_API_KEY');
  return key;
};

// USD per 1M tokens [input, output]; unknown models fall back to gpt-4o-mini pricing.
const PRICES: Record<string, [number, number]> = {
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1': [2, 8],
  'text-embedding-3-small': [0.02, 0],
};

export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string };
export type Usage = { tokensIn: number; tokensOut: number; cost: number };

export const emptyUsage = (): Usage => ({ tokensIn: 0, tokensOut: 0, cost: 0 });
export const addUsage = (total: Usage, next: Usage) => {
  total.tokensIn += next.tokensIn;
  total.tokensOut += next.tokensOut;
  total.cost += next.cost;
  return total;
};

function costFor(model: string, tokensIn: number, tokensOut: number) {
  const [input, output] = PRICES[model] || PRICES['gpt-4o-mini'];
  return (tokensIn * input + tokensOut * output) / 1_000_000;
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, `AI provider error: ${data?.error?.message || response.status}`);
  return data;
}

export async function chat({ model, messages, tools, temperature = 0.3, json = false }: {
  model: string; messages: ChatMessage[]; tools?: unknown[]; temperature?: number; json?: boolean;
}) {
  const data = await post('/chat/completions', {
    model,
    messages,
    temperature,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  });
  const tokensIn = data.usage?.prompt_tokens || 0;
  const tokensOut = data.usage?.completion_tokens || 0;
  return { message: data.choices?.[0]?.message as ChatMessage, usage: { tokensIn, tokensOut, cost: costFor(model, tokensIn, tokensOut) } };
}

export async function chatJson<T>(model: string, system: string, user: string) {
  const { message, usage } = await chat({ model, json: true, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  try {
    return { data: JSON.parse(message.content || '{}') as T, usage };
  } catch {
    return { data: {} as T, usage };
  }
}

export async function embed(texts: string[]) {
  const model = env('EMBEDDING_MODEL', 'text-embedding-3-small');
  const data = await post('/embeddings', { model, input: texts.map((text) => text.slice(0, 8000)) });
  const tokens = data.usage?.total_tokens || 0;
  return { vectors: (data.data as { embedding: number[] }[]).map((item) => item.embedding), usage: { tokensIn: tokens, tokensOut: 0, cost: costFor(model, tokens, 0) } };
}

export async function transcribe(bytes: Uint8Array, mime: string) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), `audio.${mime.split('/')[1]?.split(';')[0] || 'ogg'}`);
  form.append('model', env('TRANSCRIPTION_MODEL', 'whisper-1'));
  const response = await fetch(`${BASE_URL}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Transcription failed');
  return data.text as string;
}

export async function logAiEvent(orgId: string, kind: string, details: { conversationId?: string | null; latencyMs?: number; usage?: Usage; error?: string } = {}) {
  await admin.from('ai_events').insert({
    org_id: orgId,
    conversation_id: details.conversationId ?? null,
    kind,
    latency_ms: details.latencyMs ?? null,
    tokens_in: details.usage?.tokensIn ?? 0,
    tokens_out: details.usage?.tokensOut ?? 0,
    cost_usd: details.usage?.cost ?? 0,
    error: details.error ?? null,
  });
}
