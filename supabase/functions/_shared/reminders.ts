import { admin } from './supabase.ts';
import { deliver, isWindowOpen, openConversation } from './messaging.ts';
import { buttonsMessage, getWhatsApp } from './whatsapp.ts';
import { logAiEvent } from './ai.ts';

const copy = {
  en: { reminder: 'Reminder: your {service} appointment is on {time}.', confirm: 'Confirm', reschedule: 'Reschedule', appointment: 'appointment' },
  ar: { reminder: 'تذكير: موعدك ({service}) في {time}.', confirm: 'تأكيد', reschedule: 'تغيير الموعد', appointment: 'الموعد' },
};

export function formatInZone(value: string, timeZone: string, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return new Date(value).toUTCString();
  }
}

type Kind = '24h' | '1h';

async function sendReminder(appointment: Record<string, any>, kind: Kind) {
  const org = appointment.organizations;
  const customer = appointment.customers;
  const column = kind === '24h' ? 'reminder_24h_sent_at' : 'reminder_1h_sent_at';
  // Claim the reminder first so overlapping scheduler runs never double-send.
  const { data: claimed } = await admin.from('appointments').update({ [column]: new Date().toISOString() })
    .eq('id', appointment.id).is(column, null).select('id');
  if (!claimed?.length || !customer?.phone || customer.opted_in === false) return;

  const lang = (org.locale === 'ar' ? 'ar' : 'en') as 'en' | 'ar';
  const text = copy[lang];
  const time = formatInZone(appointment.starts_at, org.timezone || 'UTC', lang);
  const service = appointment.services?.name || text.appointment;
  try {
    const wa = await getWhatsApp(appointment.org_id);
    const conversation = await openConversation(appointment.org_id, customer.id);
    if (isWindowOpen(conversation)) {
      const body = text.reminder.replace('{service}', service).replace('{time}', time);
      await deliver(appointment.org_id, conversation.id, customer.phone, {
        text: body,
        interactive: buttonsMessage(body, [
          { id: `appt_confirm:${appointment.id}`, title: text.confirm },
          { id: `appt_reschedule:${appointment.id}`, title: text.reschedule },
        ]),
      }, { senderType: 'system' }, wa);
    } else if (org.settings?.reminder_template) {
      await deliver(appointment.org_id, conversation.id, customer.phone, {
        template: { name: org.settings.reminder_template, language: org.settings.reminder_template_language || lang, variables: [customer.full_name || '', service, time] },
      }, { senderType: 'system' }, wa);
    } else {
      await logAiEvent(appointment.org_id, 'reminder_skipped', { error: 'WhatsApp window closed and no reminder template configured' });
    }
  } catch (error) {
    await logAiEvent(appointment.org_id, 'send_error', { error: `Reminder ${kind}: ${(error as Error).message}` });
  }
}

export async function runReminders() {
  const now = Date.now();
  const select = 'id, org_id, starts_at, customers(id, full_name, phone, opted_in), services(name), organizations(timezone, locale, settings, status)';
  const window = (from: number, to: number, column: string) => admin.from('appointments').select(select)
    .in('status', ['scheduled', 'confirmed']).is(column, null)
    .gt('starts_at', new Date(now + from).toISOString()).lte('starts_at', new Date(now + to).toISOString()).limit(200);
  const [{ data: day }, { data: hour }] = await Promise.all([
    window(3600_000, 24 * 3600_000, 'reminder_24h_sent_at'),
    window(0, 3600_000, 'reminder_1h_sent_at'),
  ]);
  const active = (row: Record<string, any>) => row.organizations?.status !== 'suspended';
  for (const appointment of (day || []).filter(active)) await sendReminder(appointment, '24h');
  for (const appointment of (hour || []).filter(active)) await sendReminder(appointment, '1h');
  return { day: day?.length || 0, hour: hour?.length || 0 };
}
