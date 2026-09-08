import { query } from './supabaseClient.js';

export async function getKnowledgeBaseArticles() {
  try {
    const rows = await query('knowledge_base_articles', 'select=id,question,answer,category,keywords,is_active,usage_count,created_at&order=usage_count.desc&limit=200');
    return {
      source: 'supabase',
      items: rows.map((row) => ({
        id: row.id,
        question: row.question,
        answer: row.answer,
        category: row.category || 'General',
        keywords: Array.isArray(row.keywords) ? row.keywords : [],
        isActive: row.is_active,
        usageCount: row.usage_count || 0,
        createdAt: row.created_at,
      })),
    };
  } catch (error) {
    console.info('Knowledge base data could not be loaded:', error.message);
    return { source: 'unavailable', items: [] };
  }
}
