import { extractText, getDocumentProxy } from 'npm:unpdf@0.12.1';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { admin, must, requireRole } from '../_shared/supabase.ts';
import { addUsage, embed, emptyUsage, logAiEvent } from '../_shared/ai.ts';
import { assertPublicUrl, chunkText, htmlToText } from '../_shared/text.ts';

const MAX_BYTES = 15 * 1024 * 1024;

async function storeChunks(orgId: string, chunks: string[], link: { document_id?: string; article_id?: string }) {
  const usage = emptyUsage();
  for (let index = 0; index < chunks.length; index += 64) {
    const batch = chunks.slice(index, index + 64);
    const { vectors, usage: batchUsage } = await embed(batch);
    addUsage(usage, batchUsage);
    must(await admin.from('kb_chunks').insert(batch.map((content, offset) => ({ org_id: orgId, content, embedding: vectors[offset], ...link }))));
  }
  await logAiEvent(orgId, 'embedding', { usage });
}

async function documentText(document: Record<string, string>) {
  if (document.source_type === 'text') return document.raw_text || '';
  if (document.source_type === 'url') {
    const url = assertPublicUrl(document.source_url);
    const response = await fetch(url, { headers: { 'User-Agent': 'AutexaBot/1.0 (+knowledge import)' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Could not fetch the page (${response.status})`);
    const body = await response.text();
    return (response.headers.get('content-type') || '').includes('html') ? htmlToText(body.slice(0, 3_000_000)) : body;
  }
  const { data: file, error } = await admin.storage.from('knowledge').download(document.storage_path);
  if (error || !file) throw new Error('Uploaded file not found');
  if (file.size > MAX_BYTES) throw new Error('File is larger than 15 MB');
  const name = document.storage_path.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n\n') : text;
  }
  const raw = await file.text();
  return name.endsWith('.html') || name.endsWith('.htm') ? htmlToText(raw) : raw;
}

serve(async (request) => {
  const body = await readJson<{ org_id: string; document_id?: string; article_id?: string }>(request);
  await requireRole(request, body.org_id, 'agent');

  if (body.article_id) {
    const article = must(await admin.from('knowledge_base_articles').select('*').eq('id', body.article_id).eq('org_id', body.org_id).maybeSingle(), 'Article not found');
    await admin.from('kb_chunks').delete().eq('article_id', article.id);
    if (article.is_active) await storeChunks(body.org_id, [`Q: ${article.question}\nA: ${article.answer}`], { article_id: article.id });
    return json({ chunks: article.is_active ? 1 : 0 });
  }

  if (!body.document_id) throw new HttpError(400, 'document_id or article_id is required');
  const document = must(await admin.from('kb_documents').select('*').eq('id', body.document_id).eq('org_id', body.org_id).maybeSingle(), 'Document not found');
  await admin.from('kb_documents').update({ status: 'processing', error: null }).eq('id', document.id);
  try {
    const text = (await documentText(document)).replace(/\u0000/g, '').trim();
    if (text.length < 20) throw new Error('No readable text was found in this source');
    const chunks = chunkText(text);
    await admin.from('kb_chunks').delete().eq('document_id', document.id);
    await storeChunks(body.org_id, chunks, { document_id: document.id });
    await admin.from('kb_documents').update({ status: 'ready', chunk_count: chunks.length, error: null }).eq('id', document.id);
    return json({ chunks: chunks.length });
  } catch (error) {
    await admin.from('kb_documents').update({ status: 'failed', error: (error as Error).message.slice(0, 300) }).eq('id', document.id);
    throw new HttpError(400, (error as Error).message);
  }
});
