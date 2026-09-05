import { query } from './supabaseClient.js';

export async function getDashboardSummary() {
  try {
    const [conversations, handoffs] = await Promise.all([
      query('conversations', 'select=id,is_ai_handled,status,created_at&limit=1000'),
      query('human_handoffs', 'select=id,requested_at&limit=1000'),
    ]);
    return {
      source: 'supabase',
      conversations: conversations.length,
      aiResolved: conversations.filter((item) => item.is_ai_handled && item.status === 'resolved').length,
      handoffs: handoffs.length,
      conversationDates: conversations.map((item) => item.created_at),
    };
  } catch (error) {
    console.info('Dashboard data could not be loaded:', error.message);
    return { source: 'unavailable', conversations: null, aiResolved: null, handoffs: null, conversationDates: [] };
  }
}
