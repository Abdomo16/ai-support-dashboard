import { query } from './supabaseClient.js';

export async function getAnalyticsSummary() {
  try {
    const [conversations, handoffs, appointments, customers, messages] = await Promise.all([
      query('conversations', 'select=id,status,is_ai_handled,created_at&limit=1000'),
      query('human_handoffs', 'select=id,status,requested_at&limit=1000'),
      query('appointments', 'select=id,status,starts_at&limit=1000'),
      query('customers', 'select=id,created_at&limit=1000'),
      query('messages', 'select=id,direction,is_ai_generated,sent_at&limit=5000'),
    ]);

    const totalConversations = conversations.length;
    const aiResolved = conversations.filter((c) => c.is_ai_handled && c.status === 'resolved').length;
    const openConversations = conversations.filter((c) => c.status === 'open').length;
    const pendingHandoffs = handoffs.filter((h) => h.status === 'pending').length;
    const upcomingAppointments = appointments.filter((a) => a.status === 'scheduled' || a.status === 'confirmed').length;
    const newCustomersThisWeek = customers.filter((c) => {
      const created = new Date(c.created_at);
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      return created >= weekAgo;
    }).length;
    const inboundMessages = messages.filter((m) => m.direction === 'inbound').length;
    const outboundMessages = messages.filter((m) => m.direction === 'outbound').length;

    return {
      source: 'supabase',
      totalConversations,
      aiResolved,
      openConversations,
      pendingHandoffs,
      upcomingAppointments,
      newCustomersThisWeek,
      inboundMessages,
      outboundMessages,
      conversationDates: conversations.map((c) => c.created_at),
    };
  } catch (error) {
    console.info('Analytics data could not be loaded:', error.message);
    return { source: 'unavailable' };
  }
}
