import { query } from './supabaseClient.js';

export async function getCustomers() {
  try {
    const rows = await query('customers', 'select=id,full_name,phone,email,tags,last_seen_at,created_at,conversations(id,status)&order=last_seen_at.desc.nullslast&limit=200');
    return {
      source: 'supabase',
      items: rows.map((row) => ({
        id: row.id,
        name: row.full_name || 'Customer',
        phone: row.phone || '',
        email: row.email || '',
        tags: Array.isArray(row.tags) ? row.tags : [],
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        conversations: Array.isArray(row.conversations) ? row.conversations.length : 0,
      })),
    };
  } catch (error) {
    console.info('Customers data could not be loaded:', error.message);
    return { source: 'unavailable', items: [] };
  }
}
