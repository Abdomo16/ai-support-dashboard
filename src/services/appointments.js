import { query } from './supabaseClient.js';
import { fallbackBookings } from '../mocks/dashboard.js';

export async function getUpcomingAppointments() {
  try {
    const rows = await query('appointments', 'select=starts_at,status,customers(full_name),services(name)&order=starts_at.asc&limit=6');
    return {
      source: 'supabase',
      items: rows.map((row) => ({
        customer: row.customers?.full_name || 'Customer',
        service: row.services?.name || 'Appointment',
        when: new Date(row.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
        status: row.status || 'scheduled',
      })),
    };
  } catch (error) {
    console.info('Booking data is using the preview fallback:', error.message);
    return { source: 'preview', items: fallbackBookings };
  }
}
