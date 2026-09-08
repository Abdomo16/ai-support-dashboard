import { query } from './supabaseClient.js';
import { fallbackBookings } from '../mocks/dashboard.js';

export async function getBookings() {
  try {
    const rows = await query('appointments', 'select=id,starts_at,status,created_by_ai,customers(full_name),services(name),team_members(full_name)&order=starts_at.desc&limit=100');
    return {
      source: 'supabase',
      items: rows.map((row) => ({
        id: row.id,
        customer: row.customers?.full_name || 'Customer',
        service: row.services?.name || 'Appointment',
        startsAt: row.starts_at,
        when: new Date(row.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
        status: row.status || 'scheduled',
        createdByAi: row.created_by_ai !== false,
      })),
    };
  } catch (error) {
    console.info('Bookings page is using the preview fallback:', error.message);
    return {
      source: 'preview',
      items: fallbackBookings.map((item, index) => ({ id: `preview-${index}`, ...item, startsAt: null, createdByAi: false })),
    };
  }
}
