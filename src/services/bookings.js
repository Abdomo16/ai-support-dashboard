import { db, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

const columns = 'id,starts_at,ends_at,status,created_by_ai,notes,customer_id,service_id,team_member_id,reminder_24h_sent_at,reminder_1h_sent_at,google_event_id,customers(full_name,phone),services(name,duration_minutes,price,currency),team_members(full_name)';

export const listAppointments = ({ from, to, limit = 500 } = {}) => query('appointments', `select=${columns}&org_id=eq.${orgId()}${from ? `&starts_at=gte.${from}` : ''}${to ? `&starts_at=lt.${to}` : ''}&order=starts_at.desc&limit=${limit}`);

export const getAppointment = async (id) => (await query('appointments', `select=${columns}&id=eq.${id}&org_id=eq.${orgId()}`))[0] || null;

export async function findConflict({ id, team_member_id: staffId, starts_at: startsAt, ends_at: endsAt }) {
  if (!staffId) return null;
  const rows = await query('appointments', `select=id,starts_at,ends_at,customers(full_name)&org_id=eq.${orgId()}&team_member_id=eq.${staffId}&status=not.in.(cancelled,no_show)&starts_at=lt.${endsAt}&ends_at=gt.${startsAt}${id ? `&id=neq.${id}` : ''}&limit=1`);
  return rows[0] || null;
}

export async function saveAppointment({ id, ...values }, services) {
  const service = services.find((item) => item.id === values.service_id);
  const startsAt = new Date(values.starts_at).toISOString();
  const endsAt = values.ends_at ? new Date(values.ends_at).toISOString() : new Date(new Date(startsAt).getTime() + (service?.duration_minutes || 30) * 60000).toISOString();
  const record = {
    customer_id: values.customer_id,
    service_id: values.service_id || null,
    team_member_id: values.team_member_id || null,
    starts_at: startsAt,
    ends_at: endsAt,
    status: values.status || 'scheduled',
    notes: values.notes || null,
  };
  const conflict = await findConflict({ id, ...record });
  if (conflict) {
    const error = new Error('conflict');
    error.conflict = conflict;
    throw error;
  }
  // Rescheduling re-arms the reminders.
  if (id) return db.update('appointments', `id=eq.${id}`, { ...record, ...(values.rescheduled ? { reminder_24h_sent_at: null, reminder_1h_sent_at: null } : {}) });
  return db.insert('appointments', { org_id: orgId(), ...record, created_by_ai: false });
}

export const setAppointmentStatus = (id, status) => db.update('appointments', `id=eq.${id}`, { status });

export const listServices = () => query('services', `select=*&org_id=eq.${orgId()}&order=name`);
export const saveService = ({ id, ...values }) => (id ? db.update('services', `id=eq.${id}`, values) : db.insert('services', { org_id: orgId(), ...values }));
export const deleteService = (id) => db.remove('services', `id=eq.${id}`);

export const listStaff = () => query('team_members', `select=*&org_id=eq.${orgId()}&order=full_name`);
export const saveStaff = ({ id, ...values }) => (id ? db.update('team_members', `id=eq.${id}`, values) : db.insert('team_members', { org_id: orgId(), ...values }));
export const deleteStaff = (id) => db.remove('team_members', `id=eq.${id}`);

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const availabilityToText = (ranges = []) => ranges.map((range) => `${range.start}-${range.end}`).join(', ');
export const textToAvailability = (text = '') => text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
  const [start, end] = part.split('-').map((value) => value.trim());
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) throw new Error(`Invalid time range "${part}" (use 09:00-17:00)`);
  return { start, end };
});
