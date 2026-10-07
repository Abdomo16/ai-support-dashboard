import { esc, initials, options } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDateTime, formatMoney, formatTime, toLocalInput } from '../../lib/format.js';
import { confirmDialog, emptyRow, loadingRow, openModal, toast, toastError, wireTabs } from '../../lib/ui.js';
import {
  WEEKDAYS, availabilityToText, deleteService, deleteStaff, getAppointment, listAppointments, listServices, listStaff,
  saveAppointment, saveService, saveStaff, setAppointmentStatus, textToAvailability,
} from '../../services/bookings.js';
import { listCustomers } from '../../services/customers.js';
import { can } from '../../services/workspace.js';

const tabs = ['list', 'calendar', 'services', 'staff'];
const statuses = ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'];
const isUuid = (value) => /^[0-9a-f-]{36}$/i.test(value || '');
let listFilter = 'upcoming';
let weekOffset = 0;
let staffFilter = '';

export function render({ t, id }) {
  const tab = tabs.includes(id) ? id : 'list';
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.scheduleEyebrow)}</p><h1>${esc(t.bookings)}</h1><p>${esc(t.bookingsSubtitle)}</p></div>
      ${can('agent') ? `<button class="create" id="new-booking">＋ ${esc(t.newBooking)}</button>` : ''}
    </div>
    <div class="page-tabs">${tabs.map((key) => `<a class="page-tab ${key === tab ? 'active' : ''}" href="${href('bookings', key === 'list' ? null : key)}">${esc(t[`bookingsTab_${key}`])}</a>`).join('')}</div>
    <div id="bookings-body">${loadingRow(t.loading)}</div>`;
}

export async function mount(root, ctx) {
  const { t, id } = ctx;
  const body = root.querySelector('#bookings-body');
  const tab = tabs.includes(id) ? id : 'list';
  let services = [];
  let staff = [];
  try { [services, staff] = await Promise.all([listServices(), listStaff()]); } catch (error) { body.innerHTML = emptyRow(error.message); return; }
  const shared = { ctx, body, services, staff, reload: () => ctx.refresh() };
  root.querySelector('#new-booking')?.addEventListener('click', () => openBookingForm(shared, {}));
  if (tab === 'list') await mountList(shared);
  if (tab === 'calendar') await mountCalendar(shared);
  if (tab === 'services') mountServices(shared);
  if (tab === 'staff') mountStaff(shared);
  if (isUuid(id)) {
    const appointment = await getAppointment(id).catch(() => null);
    if (appointment) openBookingForm(shared, appointment);
  }
}

export async function create(ctx) {
  const [services, staff] = await Promise.all([listServices(), listStaff()]);
  openBookingForm({ ctx, services, staff, reload: () => ctx.refresh() }, {});
}

async function mountList({ ctx, body, services, staff }) {
  const { t } = ctx;
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="table-toolbar"><div class="filter-tabs">${['upcoming', 'past', 'all'].map((filter) => `<button class="filter-tab ${filter === listFilter ? 'active' : ''}" data-filter="${filter}">${esc(t[filter])}</button>`).join('')}</div><span class="source" id="bookings-count"></span></div>
      <div class="booking-table"><div class="booking-row booking-header five"><span>${esc(t.customer)}</span><span>${esc(t.service)}</span><span>${esc(t.staffMember)}</span><span>${esc(t.time)}</span><span>${esc(t.status)}</span></div><div class="booking-list" id="booking-rows">${loadingRow(t.loading)}</div></div>
    </article>`;
  const rows = body.querySelector('#booking-rows');
  let items = [];
  const renderRows = () => {
    const now = Date.now();
    const visible = items.filter((item) => listFilter === 'all' || (listFilter === 'upcoming' ? new Date(item.starts_at) >= now : new Date(item.starts_at) < now));
    if (listFilter === 'upcoming') visible.reverse();
    body.querySelector('#bookings-count').textContent = `${visible.length} ${t.bookings.toLowerCase()}`;
    rows.innerHTML = visible.length ? visible.map((item) => `
      <a class="booking-row five" href="${href('bookings', item.id)}">
        <span><i class="customer-avatar">${esc(initials(item.customers?.full_name))}</i>${esc(item.customers?.full_name || item.customers?.phone || t.customer)}${item.created_by_ai ? '<em class="ai-badge">AI</em>' : ''}</span>
        <span>${esc(item.services?.name || '—')}</span>
        <span>${esc(item.team_members?.full_name || '—')}</span>
        <span>${esc(formatDateTime(item.starts_at))}${item.google_event_id ? ` <small class="muted-text" title="Google Calendar">G</small>` : ''}</span>
        <span><b class="status ${esc(item.status)}">${esc(t[`status_${item.status}`] || item.status)}</b></span>
      </a>`).join('') : emptyRow(t.noBookings);
  };
  wireTabs(body, '.filter-tab', (filter) => { listFilter = filter; renderRows(); });
  try { items = await listAppointments(); renderRows(); } catch (error) { rows.innerHTML = emptyRow(error.message); }
  return { services, staff };
}

async function mountCalendar(shared) {
  const { ctx, body, staff } = shared;
  const { t, locale } = ctx;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() + weekOffset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(day.getDate() + index); return day; });
  const dateLocale = locale === 'ar' ? 'ar-EG' : 'en';
  body.innerHTML = `
    <article class="panel">
      <div class="table-toolbar flush">
        <div class="toolbar-group"><button class="ghost-btn" id="prev-week">‹</button><button class="ghost-btn" id="this-week">${esc(t.today)}</button><button class="ghost-btn" id="next-week">›</button>
        <strong>${esc(start.toLocaleDateString(dateLocale, { month: 'long', day: 'numeric' }))} – ${esc(days[6].toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' }))}</strong></div>
        <select class="mini-select" id="staff-filter">${options([['', t.allStaff], ...staff.map((member) => [member.id, member.full_name])], staffFilter)}</select>
      </div>
      <div class="calendar" id="calendar">${loadingRow(t.loading)}</div>
    </article>`;
  const navigate = (offset) => { weekOffset = offset; mountCalendar(shared); };
  body.querySelector('#prev-week').addEventListener('click', () => navigate(weekOffset - 1));
  body.querySelector('#next-week').addEventListener('click', () => navigate(weekOffset + 1));
  body.querySelector('#this-week').addEventListener('click', () => navigate(0));
  body.querySelector('#staff-filter').addEventListener('change', (event) => { staffFilter = event.target.value; mountCalendar(shared); });
  try {
    const items = (await listAppointments({ from: start.toISOString(), to: end.toISOString() }))
      .filter((item) => !staffFilter || item.team_member_id === staffFilter)
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    const staffIndex = new Map(staff.map((member, index) => [member.id, index % 6]));
    const today = new Date().toDateString();
    body.querySelector('#calendar').innerHTML = days.map((day) => {
      const dayItems = items.filter((item) => new Date(item.starts_at).toDateString() === day.toDateString());
      const weekday = WEEKDAYS[day.getDay()];
      const working = staff.filter((member) => (!staffFilter || member.id === staffFilter) && (member.availability?.[weekday] || []).length);
      return `
        <div class="calendar-day ${day.toDateString() === today ? 'today' : ''}">
          <div class="calendar-day-head"><strong>${esc(day.toLocaleDateString(dateLocale, { weekday: 'short' }))}</strong><span>${day.getDate()}</span></div>
          ${working.length ? `<small class="calendar-hours">${working.map((member) => `${esc(member.full_name.split(' ')[0])} ${esc(availabilityToText(member.availability[weekday]))}`).join('<br>')}</small>` : ''}
          ${dayItems.map((item) => `
            <a class="calendar-event staff-${staffIndex.get(item.team_member_id) ?? 'none'} ${esc(item.status)}" href="${href('bookings', item.id)}">
              <b>${esc(formatTime(item.starts_at))}</b> ${esc(item.customers?.full_name || item.customers?.phone || '')}
              <small>${esc(item.services?.name || '')}${item.team_members?.full_name ? ` · ${esc(item.team_members.full_name)}` : ''}</small>
            </a>`).join('') || `<small class="muted-text">${esc(t.noBookingsDay)}</small>`}
        </div>`;
    }).join('');
  } catch (error) { body.querySelector('#calendar').innerHTML = emptyRow(error.message); }
}

async function openBookingForm(shared, appointment) {
  const { ctx, services, staff } = shared;
  const { t } = ctx;
  let customers = [];
  try { customers = await listCustomers(1000); } catch (error) { toastError(error); return; }
  const isEdit = Boolean(appointment.id);
  const readOnly = !can('agent');
  openModal({
    title: isEdit ? t.editBooking : t.newBooking,
    html: isEdit ? `<div class="reminder-status">
        <span class="tag ${appointment.reminder_24h_sent_at ? 'tag-light' : ''}">${esc(t.reminder24h)}: ${esc(appointment.reminder_24h_sent_at ? t.sent : t.notSent)}</span>
        <span class="tag ${appointment.reminder_1h_sent_at ? 'tag-light' : ''}">${esc(t.reminder1h)}: ${esc(appointment.reminder_1h_sent_at ? t.sent : t.notSent)}</span>
        ${appointment.google_event_id ? `<span class="tag tag-light">${esc(t.syncedToGoogle)}</span>` : ''}
        ${appointment.customer_id ? `<a class="link" href="${href('customers', appointment.customer_id)}">${esc(t.viewCustomer)} →</a>` : ''}
      </div>` : '',
    fields: [
      { name: 'customer_id', label: t.customer, type: 'select', required: true, value: appointment.customer_id, options: [['', t.chooseCustomer], ...customers.map((customer) => [customer.id, `${customer.full_name || ''} ${customer.phone || ''}`.trim()])], disabled: readOnly },
      { name: 'service_id', label: t.service, type: 'select', value: appointment.service_id, options: [['', '—'], ...services.filter((service) => service.is_active || service.id === appointment.service_id).map((service) => [service.id, `${service.name} (${service.duration_minutes} min)`])], disabled: readOnly },
      { name: 'team_member_id', label: t.staffMember, type: 'select', value: appointment.team_member_id, options: [['', '—'], ...staff.filter((member) => member.is_active || member.id === appointment.team_member_id).map((member) => [member.id, member.full_name])], disabled: readOnly },
      { name: 'status', label: t.status, type: 'select', value: appointment.status || 'scheduled', options: statuses.map((status) => [status, t[`status_${status}`] || status]), disabled: readOnly },
      { name: 'starts_at', label: t.startsAt, type: 'datetime-local', required: true, value: toLocalInput(appointment.starts_at), disabled: readOnly },
      { name: 'ends_at', label: t.endsAt, type: 'datetime-local', value: toLocalInput(appointment.ends_at), hint: t.endsAtHint, disabled: readOnly },
      { name: 'notes', label: t.notes, type: 'textarea', value: appointment.notes, rows: 2, disabled: readOnly },
    ],
    hideSubmit: readOnly,
    onMount: (form, close) => {
      if (!isEdit || readOnly || appointment.status === 'cancelled') return;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ghost-btn danger-text';
      cancel.textContent = t.cancelBooking;
      cancel.addEventListener('click', async () => {
        if (!await confirmDialog(t.cancelBookingConfirm)) return;
        try { await setAppointmentStatus(appointment.id, 'cancelled'); toast(t.bookingCancelled, 'success'); close(); shared.reload(); } catch (error) { toastError(error); }
      });
      form.querySelector('.modal-foot').prepend(cancel);
    },
    onSubmit: async (values) => {
      const rescheduled = isEdit && new Date(values.starts_at).toISOString() !== new Date(appointment.starts_at).toISOString();
      try {
        await saveAppointment({ id: appointment.id, ...values, ends_at: values.ends_at && !rescheduled ? values.ends_at : (isEdit && !rescheduled ? appointment.ends_at : null), rescheduled }, services);
      } catch (error) {
        if (error.conflict) throw new Error(t.bookingConflict.replace('{name}', error.conflict.customers?.full_name || '').replace('{time}', formatTime(error.conflict.starts_at)));
        throw error;
      }
      toast(t.saved, 'success');
      if (isUuid(ctx.id)) ctx.navigate('bookings'); else shared.reload();
    },
  });
}

function mountServices({ ctx, body, services }) {
  const { t } = ctx;
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="table-toolbar"><span class="source">${services.length} ${esc(t.services.toLowerCase())}</span>${can('admin') ? `<button class="create small" id="add-service">＋ ${esc(t.newService)}</button>` : ''}</div>
      <div class="simple-list">${services.length ? services.map((service) => `
        <div class="list-row"><div><strong>${esc(service.name)} ${service.is_active ? '' : `<span class="tag tag-inactive">${esc(t.inactive)}</span>`}</strong><small>${esc(service.duration_minutes)} min · ${esc(service.price !== null ? formatMoney(service.price, service.currency) : '—')} ${service.description ? `· ${esc(service.description)}` : ''}</small></div>
        ${can('admin') ? `<div class="row-actions"><button class="ghost-btn" data-edit="${service.id}">${esc(t.edit)}</button><button class="ghost-btn danger-text" data-delete="${service.id}">${esc(t.delete)}</button></div>` : ''}</div>`).join('') : emptyRow(t.noServices)}</div>
    </article>`;
  const form = (service = {}) => openModal({
    title: service.id ? t.editService : t.newService,
    fields: [
      { name: 'name', label: t.name, required: true, value: service.name },
      { name: 'duration_minutes', label: t.durationMinutes, type: 'number', min: 5, step: 5, value: service.duration_minutes || 30, required: true },
      { name: 'price', label: t.price, type: 'number', min: 0, step: 0.01, value: service.price },
      { name: 'currency', label: t.currency, value: service.currency || 'USD' },
      { name: 'description', label: t.description, type: 'textarea', value: service.description, rows: 2 },
      { name: 'is_active', label: t.active, type: 'checkbox', value: service.is_active !== false },
    ],
    onSubmit: async (values) => { await saveService({ id: service.id, ...values }); toast(t.saved, 'success'); ctx.refresh(); },
  });
  body.querySelector('#add-service')?.addEventListener('click', () => form());
  body.addEventListener('click', async (event) => {
    const editId = event.target.closest('[data-edit]')?.dataset.edit;
    const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
    if (editId) form(services.find((service) => service.id === editId));
    if (deleteId && await confirmDialog(t.deleteConfirm)) {
      try { await deleteService(deleteId); ctx.refresh(); } catch (error) { toastError(error); }
    }
  });
}

function mountStaff({ ctx, body, staff }) {
  const { t } = ctx;
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="table-toolbar"><span class="source">${staff.length} ${esc(t.staff.toLowerCase())}</span>${can('admin') ? `<button class="create small" id="add-staff">＋ ${esc(t.newStaff)}</button>` : ''}</div>
      <div class="simple-list">${staff.length ? staff.map((member) => `
        <div class="list-row"><div><strong>${esc(member.full_name)} ${member.is_active ? '' : `<span class="tag tag-inactive">${esc(t.inactive)}</span>`}</strong>
        <small>${WEEKDAYS.filter((day) => (member.availability?.[day] || []).length).map((day) => `${esc(t[`day_${day}`])} ${esc(availabilityToText(member.availability[day]))}`).join(' · ') || esc(t.noAvailability)}</small></div>
        ${can('admin') ? `<div class="row-actions"><button class="ghost-btn" data-edit="${member.id}">${esc(t.edit)}</button><button class="ghost-btn danger-text" data-delete="${member.id}">${esc(t.delete)}</button></div>` : ''}</div>`).join('') : emptyRow(t.noStaff)}</div>
    </article>`;
  const form = (member = {}) => openModal({
    title: member.id ? t.editStaff : t.newStaff,
    html: `<p class="muted-text">${esc(t.availabilityHint)}</p>`,
    fields: [
      { name: 'full_name', label: t.fullName, required: true, value: member.full_name },
      { name: 'email', label: t.email, type: 'email', value: member.email },
      { name: 'phone', label: t.phone, value: member.phone },
      { name: 'is_active', label: t.active, type: 'checkbox', value: member.is_active !== false },
      ...WEEKDAYS.map((day) => ({ name: `day_${day}`, label: t[`day_${day}`], value: availabilityToText(member.availability?.[day]), placeholder: '09:00-13:00, 14:00-18:00' })),
    ],
    onSubmit: async (values) => {
      const availability = Object.fromEntries(WEEKDAYS.map((day) => [day, textToAvailability(values[`day_${day}`])]));
      await saveStaff({ id: member.id, full_name: values.full_name, email: values.email || null, phone: values.phone || null, is_active: values.is_active, availability });
      toast(t.saved, 'success');
      ctx.refresh();
    },
  });
  body.querySelector('#add-staff')?.addEventListener('click', () => form());
  body.addEventListener('click', async (event) => {
    const editId = event.target.closest('[data-edit]')?.dataset.edit;
    const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
    if (editId) form(staff.find((member) => member.id === editId));
    if (deleteId && await confirmDialog(t.deleteConfirm)) {
      try { await deleteStaff(deleteId); ctx.refresh(); } catch (error) { toastError(error); }
    }
  });
}
