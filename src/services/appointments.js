import { query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export async function getUpcomingAppointments(limit = 6) {
  const rows = await query('appointments', `select=id,starts_at,status,created_by_ai,customers(full_name,phone),services(name)&org_id=eq.${orgId()}&starts_at=gte.${new Date().toISOString()}&status=not.in.(cancelled,no_show)&order=starts_at.asc&limit=${limit}`);
  return rows.map((row) => ({
    id: row.id,
    customer: row.customers?.full_name || row.customers?.phone || '',
    service: row.services?.name || '',
    startsAt: row.starts_at,
    status: row.status || 'scheduled',
    createdByAi: row.created_by_ai,
  }));
}
