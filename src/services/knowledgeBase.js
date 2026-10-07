import { db, invokeFunction, query, removeFile, uploadFile } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const listArticles = () => query('knowledge_base_articles', `select=*&org_id=eq.${orgId()}&order=usage_count.desc,created_at.desc&limit=1000`);

const reindexArticle = (articleId) => invokeFunction('kb-ingest', { org_id: orgId(), article_id: articleId }).catch((error) => console.warn('Article indexing failed', error));

export async function saveArticle({ id, question, answer, category, keywords, is_active: isActive, source }) {
  const record = { question, answer, category: category || null, keywords: keywords || [], is_active: isActive !== false };
  const [saved] = id
    ? await db.update('knowledge_base_articles', `id=eq.${id}`, record)
    : await db.insert('knowledge_base_articles', { org_id: orgId(), ...record, source: source || 'manual' });
  reindexArticle(saved.id);
  return saved;
}

export const deleteArticle = (id) => db.remove('knowledge_base_articles', `id=eq.${id}`);

export const listDocuments = () => query('kb_documents', `select=id,title,source_type,source_url,storage_path,status,error,chunk_count,created_at&org_id=eq.${orgId()}&order=created_at.desc`);

export async function addDocument({ title, file, url, text }) {
  let record;
  if (file) {
    const path = `${orgId()}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_')}`;
    await uploadFile('knowledge', path, file);
    record = { title: title || file.name, source_type: 'file', storage_path: path };
  } else if (url) {
    record = { title: title || url, source_type: 'url', source_url: url };
  } else {
    record = { title: title || text.slice(0, 60), source_type: 'text', raw_text: text };
  }
  const [document] = await db.insert('kb_documents', { org_id: orgId(), ...record, status: 'pending' });
  await ingestDocument(document.id);
  return document;
}

export const ingestDocument = (documentId) => invokeFunction('kb-ingest', { org_id: orgId(), document_id: documentId });

export async function deleteDocument(document) {
  await db.remove('kb_documents', `id=eq.${document.id}`);
  if (document.storage_path) await removeFile('knowledge', document.storage_path).catch(() => {});
}

export const listUnanswered = (status = 'open') => query('unanswered_questions', `select=*&org_id=eq.${orgId()}&status=eq.${status}&order=occurrences.desc,last_asked_at.desc&limit=200`);
export const setUnansweredStatus = (id, status, articleId = null) => db.update('unanswered_questions', `id=eq.${id}`, { status, article_id: articleId });
