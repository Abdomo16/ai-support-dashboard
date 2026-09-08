import { query } from './supabaseClient.js';

export async function getConversations() {
  try {
    const rows = await query('conversations', 'select=id,status,is_ai_handled,last_message_at,last_message_preview,created_at,customers(id,full_name,phone),messages(id,content,sent_at,direction,is_ai_generated)&order=last_message_at.desc.nullslast&limit=200');
    return {
      source: 'supabase',
      items: rows.map((row) => {
        const lastMessage = row.messages?.length
          ? row.messages.reduce((latest, current) => (new Date(current.sent_at) > new Date(latest.sent_at) ? current : latest), row.messages[0])
          : null;
        return {
          id: row.id,
          status: row.status || 'open',
          isAiHandled: row.is_ai_handled,
          customer: row.customers?.full_name || row.customers?.phone || 'Customer',
          phone: row.customers?.phone || '',
          preview: row.last_message_preview || lastMessage?.content || '',
          lastMessageAt: row.last_message_at || row.created_at,
          lastMessageDirection: lastMessage?.direction || 'inbound',
        };
      }),
    };
  } catch (error) {
    console.info('Conversations data could not be loaded:', error.message);
    return { source: 'unavailable', items: [] };
  }
}

export async function getConversationMessages(conversationId) {
  try {
    const rows = await query('messages', `select=content,sent_at,direction,is_ai_generated&conversation_id=eq.${encodeURIComponent(conversationId)}&order=sent_at.desc&limit=50`);
    return {
      source: 'supabase',
      items: rows.map((row) => ({
        content: row.content || '',
        sentAt: row.sent_at,
        direction: row.direction || 'inbound',
        isAiGenerated: row.is_ai_generated,
      })),
    };
  } catch (error) {
    console.info('Messages could not be loaded:', error.message);
    return { source: 'unavailable', items: [] };
  }
}
