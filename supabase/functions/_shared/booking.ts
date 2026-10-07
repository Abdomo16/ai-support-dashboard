import { admin, must } from './supabase.ts';
import { emitEvent } from './events.ts';
import { weekdayOf, zonedToUtc } from './time.ts';

export async function availableSlots(orgId: string, serviceId: string, day: string, timeZone: string, limit = 12) {
  const { data: service } = await admin.from('services').select('id, name, duration_minutes').eq('id', serviceId).eq('org_id', orgId).maybeSingle();
  if (!service) return { error: 'Unknown service' };
  const { data: staff } = await admin.from('team_members').select('id, full_name, availability').eq('org_id', orgId).eq('is_active', true);
  const dayStart = zonedToUtc(day, '00:00', timeZone);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const { data: booked } = await admin.from('appointments').select('team_member_id, starts_at, ends_at')
    .eq('org_id', orgId).not('status', 'in', '(cancelled,no_show)').gte('starts_at', dayStart.toISOString()).lt('starts_at', dayEnd.toISOString());
  const duration = (service.duration_minutes || 30) * 60000;
  const weekday = weekdayOf(day);
  const slots: { starts_at: string; team_member_id: string; staff: string; local_time: string }[] = [];
  for (const member of staff || []) {
    for (const range of (member.availability?.[weekday] || []) as { start: string; end: string }[]) {
      const rangeEnd = zonedToUtc(day, range.end, timeZone).getTime();
      for (let start = zonedToUtc(day, range.start, timeZone).getTime(); start + duration <= rangeEnd; start += Math.max(duration, 30 * 60000)) {
        if (start < Date.now() + 30 * 60000) continue;
        const end = start + duration;
        const clash = (booked || []).some((item) => item.team_member_id === member.id
          && new Date(item.starts_at).getTime() < end && new Date(item.ends_at || item.starts_at).getTime() + (item.ends_at ? 0 : duration) > start);
        if (!clash) {
          const localTime = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(start));
          slots.push({ starts_at: new Date(start).toISOString(), team_member_id: member.id, staff: member.full_name, local_time: localTime });
        }
      }
    }
  }
  slots.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return { service: service.name, day, slots: slots.slice(0, limit) };
}

export async function createBooking(orgId: string, input: { customerId: string; conversationId?: string; serviceId: string; startsAt: string; teamMemberId?: string; notes?: string }) {
  const { data: service } = await admin.from('services').select('duration_minutes, name').eq('id', input.serviceId).eq('org_id', orgId).maybeSingle();
  if (!service) return { error: 'Unknown service' };
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now()) return { error: 'The requested time is invalid or in the past' };
  const endsAt = new Date(startsAt.getTime() + (service.duration_minutes || 30) * 60000);
  if (input.teamMemberId) {
    const { data: clash } = await admin.from('appointments').select('id').eq('org_id', orgId).eq('team_member_id', input.teamMemberId)
      .not('status', 'in', '(cancelled,no_show)').lt('starts_at', endsAt.toISOString()).gt('ends_at', startsAt.toISOString()).limit(1);
    if (clash?.length) return { error: 'That slot was just taken; offer another time' };
  }
  const appointment = must(await admin.from('appointments').insert({
    org_id: orgId,
    customer_id: input.customerId,
    conversation_id: input.conversationId ?? null,
    service_id: input.serviceId,
    team_member_id: input.teamMemberId ?? null,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    status: 'scheduled',
    created_by_ai: true,
    notes: input.notes ?? null,
  }).select('id, starts_at').single());
  await emitEvent(orgId, 'booking.created', { appointment_id: appointment.id, service: service.name, starts_at: appointment.starts_at, customer_id: input.customerId });
  return { booked: true, appointment_id: appointment.id, service: service.name, starts_at: appointment.starts_at };
}
