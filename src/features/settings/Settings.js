import { esc, options } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { download } from '../../lib/csv.js';
import { formatDateTime, timeAgo } from '../../lib/format.js';
import { requestBrowserNotifications } from '../../lib/notify.js';
import { confirmDialog, emptyRow, field, formValues, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import { hoursEditor, readHours, wireHoursEditor } from '../../components/businessHours.js';
import { deleteCannedResponse, getCannedResponses, saveCannedResponse } from '../../services/cannedResponses.js';
import {
  changePassword, createApiKey, deleteWorkspace, exportWorkspaceData, listApiKeys, listAuditLog, revokeApiKey, updateOrgSettings, updateOrganization, updateProfile, uploadLogo,
} from '../../services/settings.js';
import { publicApiUrl } from '../../services/integrations.js';
import { getInvitations, getMembers, inviteMember, memberName, removeMember, revokeInvitation, setMemberRole } from '../../services/team.js';
import { can, updateMemberPrefs, workspace } from '../../services/workspace.js';

const TABS = [
  { key: 'general', min: 'admin' },
  { key: 'branding', min: 'admin' },
  { key: 'team', min: 'viewer' },
  { key: 'canned', min: 'agent' },
  { key: 'notifications', min: 'viewer' },
  { key: 'api', min: 'admin' },
  { key: 'audit', min: 'admin' },
  { key: 'compliance', min: 'admin' },
  { key: 'profile', min: 'viewer' },
];
const ROLES = ['owner', 'admin', 'agent', 'viewer'];
const AUDITED = ['organizations', 'org_members', 'org_invitations', 'ai_settings', 'automations', 'integrations', 'whatsapp_accounts', 'broadcasts', 'whatsapp_templates', 'knowledge_base_articles', 'api_keys', 'products', 'services', 'team_members'];

const visibleTabs = () => TABS.filter((tab) => can(tab.min));
const activeTab = (id) => (visibleTabs().some((tab) => tab.key === id) ? id : visibleTabs()[0].key);

export function render({ t, id }) {
  const tab = activeTab(id);
  return `
    <div class="page-heading"><div><p class="eyebrow">${esc(t.workspaceGroup)}</p><h1>${esc(t.settings)}</h1><p>${esc(t.settingsSubtitle)}</p></div></div>
    <div class="page-tabs">${visibleTabs().map(({ key }) => `<a class="page-tab ${key === tab ? 'active' : ''}" href="${href('settings', key)}">${esc(t[`settingsTab_${key}`])}</a>`).join('')}</div>
    <div id="settings-body">${loadingRow(t.loading)}</div>`;
}

export async function mount(root, ctx) {
  const tab = activeTab(ctx.id);
  const body = root.querySelector('#settings-body');
  const mounts = { general, branding, team, canned, notifications, api, audit, compliance, profile };
  try { return await mounts[tab](body, ctx); } catch (error) { body.innerHTML = emptyRow(error.message); return undefined; }
}

function formPanel(body, { fields, html = '', submitLabel, onSubmit, t }) {
  body.innerHTML = `<form class="panel settings-form"><div class="form-grid">${fields.map(field).join('')}</div>${html}<div class="form-actions"><button class="create" type="submit">${esc(submitLabel || t.save)}</button></div></form>`;
  const form = body.querySelector('form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try { await onSubmit(formValues(form), form); toast(t.saved, 'success'); } catch (error) { toastError(error); } finally { button.disabled = false; }
  });
  return form;
}

function general(body, ctx) {
  const { t } = ctx;
  const org = workspace.org;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [org.timezone || 'UTC'];
  const form = formPanel(body, {
    t,
    fields: [
      { name: 'name', label: t.workspaceName, required: true, value: org.name },
      { name: 'industry', label: t.industry, value: org.industry },
      { name: 'timezone', label: t.timezone, type: 'select', value: org.timezone, options: zones.map((zone) => [zone, zone]) },
      { name: 'locale', label: t.customerLanguage, type: 'select', value: org.locale, options: [['ar', 'العربية'], ['en', 'English']], hint: t.customerLanguageHint },
      { name: 'currency', label: t.currency, type: 'select', value: org.settings?.currency || 'USD', options: ['USD', 'SAR', 'AED', 'EGP', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'MAD', 'EUR'].map((code) => [code, code]) },
      { name: 'reminder_template', label: t.reminderTemplate, value: org.settings?.reminder_template, hint: t.reminderTemplateHint },
    ],
    html: `<div class="form-field full"><label>${esc(t.businessHours)}</label>${hoursEditor(t, org.business_hours)}</div>`,
    onSubmit: async (values, formElement) => {
      await updateOrganization({
        name: values.name,
        industry: values.industry || null,
        timezone: values.timezone,
        locale: values.locale,
        business_hours: readHours(formElement),
        settings: { ...(org.settings || {}), currency: values.currency, reminder_template: values.reminder_template || null },
      });
      ctx.rebootShell();
    },
  });
  wireHoursEditor(form);
}

function branding(body, ctx) {
  const { t } = ctx;
  const org = workspace.org;
  const isAgency = org.is_agency || Boolean(org.parent_org_id);
  const form = formPanel(body, {
    t,
    fields: [
      { name: 'brand_name', label: t.brandName, value: org.brand_name, placeholder: org.name, hint: t.brandNameHint },
      { name: 'brand_color', label: t.brandColor, type: 'color', value: org.brand_color || '#7c6cff' },
      { name: 'logo', label: t.logo, type: 'file', accept: 'image/*', hint: t.logoHint },
      ...(isAgency ? [{ name: 'custom_domain', label: t.customDomain, value: org.custom_domain, placeholder: 'support.youragency.com', hint: t.customDomainHint }] : []),
    ],
    html: `<div class="brand-preview"><span class="brand-mark" id="logo-preview">${org.logo_url ? `<img src="${esc(org.logo_url)}" alt="" />` : esc((org.brand_name || org.name || 'A')[0])}</span><strong>${esc(org.brand_name || org.name)}</strong>${org.logo_url ? `<button type="button" class="ghost-btn danger-text" id="remove-logo">${esc(t.removeLogo)}</button>` : ''}</div>
      ${isAgency ? '' : `<p class="muted-text">${esc(t.whiteLabelAgencyOnly)}</p>`}`,
    onSubmit: async (values) => {
      const patch = { brand_name: values.brand_name || null, brand_color: values.brand_color };
      if (values.logo) patch.logo_url = await uploadLogo(values.logo);
      if (isAgency) patch.custom_domain = values.custom_domain?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
      await updateOrganization(patch);
      ctx.rebootShell();
    },
  });
  form.querySelector('#remove-logo')?.addEventListener('click', async () => {
    try { await updateOrganization({ logo_url: null }); ctx.rebootShell(); } catch (error) { toastError(error); }
  });
}

async function team(body, ctx) {
  const { t } = ctx;
  const [members, invitations] = await Promise.all([getMembers(), can('admin') ? getInvitations() : Promise.resolve([])]);
  const assignable = ROLES.filter((role) => role !== 'owner' || can('owner'));
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="panel-head"><div><h2>${esc(t.members)}</h2><p>${esc(t.rolesHelp)}</p></div>${can('admin') ? `<button class="create" id="invite">＋ ${esc(t.inviteMember)}</button>` : ''}</div>
      <div class="simple-list">${members.map((member) => `
        <div class="list-row" data-user="${member.user_id}">
          <div><strong>${esc(memberName(member))}${member.user_id === workspace.user.id ? ` (${esc(t.you)})` : ''}</strong><small>${esc(member.profiles?.email || '')} · ${esc(t.joined)} ${esc(timeAgo(member.created_at))}</small></div>
          <div class="row-actions">
            ${can('admin') && member.user_id !== workspace.user.id && (member.role !== 'owner' || can('owner'))
    ? `<select class="compact-select" data-role>${options(assignable.map((role) => [role, t[`role_${role}`]]), member.role)}</select><button class="ghost-btn danger-text" data-remove>${esc(t.remove)}</button>`
    : `<span class="tag">${esc(t[`role_${member.role}`])}</span>`}
          </div>
        </div>`).join('')}</div>
    </article>
    ${can('admin') ? `<article class="panel table-panel"><div class="panel-head"><h2>${esc(t.pendingInvitations)}</h2></div>
      <div class="simple-list">${invitations.length ? invitations.map((invite) => `
        <div class="list-row"><div><strong>${esc(invite.email)}</strong><small>${esc(t[`role_${invite.role}`])} · ${esc(timeAgo(invite.created_at))}</small></div><button class="ghost-btn danger-text" data-revoke="${invite.id}">${esc(t.revoke)}</button></div>`).join('') : emptyRow(t.noInvitations)}</div></article>` : ''}`;
  body.querySelector('#invite')?.addEventListener('click', () => openModal({
    title: t.inviteMember,
    fields: [
      { name: 'email', label: t.email, type: 'email', required: true, full: true },
      { name: 'role', label: t.role, type: 'select', value: 'agent', options: assignable.map((role) => [role, t[`role_${role}`]]) },
    ],
    html: `<p class="muted-text">${esc(t.inviteHelp)}</p>`,
    submitLabel: t.sendInvite,
    onSubmit: async (values) => { await inviteMember(values.email, values.role); toast(t.inviteSent, 'success'); ctx.refresh(); },
  }));
  body.addEventListener('change', async (event) => {
    if (!event.target.matches('[data-role]')) return;
    try { await setMemberRole(event.target.closest('[data-user]').dataset.user, event.target.value); toast(t.saved, 'success'); } catch (error) { toastError(error); ctx.refresh(); }
  });
  body.addEventListener('click', async (event) => {
    const userId = event.target.closest('[data-remove]') && event.target.closest('[data-user]').dataset.user;
    const inviteId = event.target.closest('[data-revoke]')?.dataset.revoke;
    try {
      if (userId && await confirmDialog(t.removeMemberConfirm)) { await removeMember(userId); ctx.refresh(); }
      if (inviteId) { await revokeInvitation(inviteId); ctx.refresh(); }
    } catch (error) { toastError(error); }
  });
}

async function canned(body, ctx) {
  const { t } = ctx;
  const items = await getCannedResponses();
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="panel-head"><div><h2>${esc(t.cannedResponses)}</h2><p>${esc(t.cannedHelp)}</p></div><button class="create" id="new-canned">＋ ${esc(t.newCannedResponse)}</button></div>
      <div class="simple-list">${items.length ? items.map((item) => `
        <div class="list-row"><div><strong><span class="mono">/${esc(item.shortcut)}</span> · ${esc(item.title)}</strong><small>${esc(item.body.slice(0, 160))}</small></div>
        <div class="row-actions"><button class="ghost-btn" data-edit="${item.id}">${esc(t.edit)}</button>${can('admin') ? `<button class="ghost-btn danger-text" data-delete="${item.id}">${esc(t.delete)}</button>` : ''}</div></div>`).join('') : emptyRow(t.noCannedResponses)}</div>
    </article>`;
  const open = (item = {}) => openModal({
    title: item.id ? t.editCannedResponse : t.newCannedResponse,
    fields: [
      { name: 'shortcut', label: t.shortcut, required: true, value: item.shortcut, placeholder: 'hours' },
      { name: 'title', label: t.title, required: true, value: item.title },
      { name: 'body', label: t.message, type: 'textarea', required: true, rows: 5, value: item.body, hint: t.cannedVariablesHint },
    ],
    onSubmit: async (values) => {
      await saveCannedResponse({ id: item.id, ...values, shortcut: values.shortcut.replace(/^\//, '').toLowerCase().replace(/\s+/g, '-') });
      ctx.refresh();
    },
  });
  body.querySelector('#new-canned').addEventListener('click', () => open());
  body.addEventListener('click', async (event) => {
    const editId = event.target.closest('[data-edit]')?.dataset.edit;
    const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
    if (editId) open(items.find((item) => item.id === editId));
    if (deleteId && await confirmDialog(t.deleteConfirm)) {
      try { await deleteCannedResponse(deleteId); ctx.refresh(); } catch (error) { toastError(error); }
    }
  });
}

function notifications(body, ctx) {
  const { t } = ctx;
  const prefs = workspace.memberPrefs || {};
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  formPanel(body, {
    t,
    fields: [
      { name: 'handoffs', label: t.notifyHandoffs, type: 'checkbox', value: prefs.handoffs !== false, full: true },
      { name: 'sound', label: t.notifySound, type: 'checkbox', value: prefs.sound !== false, full: true },
      { name: 'browser', label: t.notifyBrowser, type: 'checkbox', value: prefs.browser !== false, full: true, hint: t[`browserPermission_${permission}`] },
      ...(can('admin') ? [
        { name: 'weekly_report', label: t.notifyWeeklyReport, type: 'checkbox', value: prefs.weekly_report !== false, full: true },
        { name: 'usage_alerts', label: t.notifyUsageAlerts, type: 'checkbox', value: prefs.usage_alerts !== false, full: true },
      ] : []),
    ],
    onSubmit: async (values) => {
      if (values.browser && permission === 'default') await requestBrowserNotifications();
      await updateMemberPrefs(values);
    },
  });
}

async function api(body, ctx) {
  const { t } = ctx;
  const keys = await listApiKeys();
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="panel-head"><div><h2>${esc(t.apiKeys)}</h2><p>${esc(t.apiKeysHelp)}</p></div><button class="create" id="new-key">＋ ${esc(t.createApiKey)}</button></div>
      <div class="simple-list">${keys.length ? keys.map((key) => `
        <div class="list-row"><div><strong>${esc(key.name)} <span class="mono">${esc(key.prefix)}…</span></strong><small>${esc(t.created)} ${esc(formatDateTime(key.created_at))} · ${esc(key.last_used_at ? `${t.lastUsed} ${timeAgo(key.last_used_at)}` : t.neverUsed)}</small></div>
        ${key.revoked_at ? `<span class="tag tag-inactive">${esc(t.revoked)}</span>` : `<button class="ghost-btn danger-text" data-revoke="${key.id}">${esc(t.revoke)}</button>`}</div>`).join('') : emptyRow(t.noApiKeys)}</div>
    </article>
    <article class="panel api-docs">
      <h2>${esc(t.apiDocs)}</h2>
      <p class="muted-text">${esc(t.apiDocsHelp)}</p>
      <pre class="mono">${esc(`POST ${publicApiUrl()}
x-api-key: atx_…
Content-Type: application/json

{ "action": "send_message", "phone": "+9665…", "text": "Hello!" }
{ "action": "send_template", "phone": "+9665…", "template": "order_update", "language": "ar", "variables": ["Sara", "#1042"] }
{ "action": "upsert_customer", "phone": "+9665…", "full_name": "Sara", "tags": ["vip"] }
{ "action": "create_booking", "phone": "+9665…", "service_id": "…", "starts_at": "2026-10-09T10:00:00Z" }
{ "action": "list_conversations", "status": "open", "limit": 50 }`)}</pre>
    </article>`;
  body.querySelector('#new-key').addEventListener('click', () => openModal({
    title: t.createApiKey,
    fields: [{ name: 'name', label: t.name, required: true, placeholder: 'Zapier', full: true }],
    onSubmit: async (values) => {
      const key = await createApiKey(values.name);
      openModal({ title: t.apiKeyCreated, hideSubmit: true, html: `<p>${esc(t.apiKeyOnce)}</p><code class="mono secret-box">${esc(key)}</code>`, onMount: () => navigator.clipboard?.writeText(key).catch(() => {}) });
      ctx.refresh();
    },
  }));
  body.addEventListener('click', async (event) => {
    const id = event.target.closest('[data-revoke]')?.dataset.revoke;
    if (id && await confirmDialog(t.revokeKeyConfirm)) {
      try { await revokeApiKey(id); ctx.refresh(); } catch (error) { toastError(error); }
    }
  });
}

async function audit(body, ctx) {
  const { t } = ctx;
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="table-toolbar"><span class="source">${esc(t.auditHelp)}</span>
        <select class="compact-select" id="audit-entity">${options([['', t.all], ...AUDITED.map((entity) => [entity, t[`entity_${entity}`] || entity])], '')}</select></div>
      <div class="simple-list" id="audit-list">${loadingRow(t.loading)}</div>
      <div class="form-actions"><button class="ghost-btn" id="audit-more" hidden>${esc(t.loadMore)}</button></div>
    </article>`;
  const list = body.querySelector('#audit-list');
  const more = body.querySelector('#audit-more');
  let last = null;
  const describe = (row) => {
    const changed = Array.isArray(row.details?.changed) ? row.details.changed.join(', ') : '';
    return `${t[`auditAction_${row.action}`] || row.action} · ${t[`entity_${row.entity}`] || row.entity}${changed ? ` (${changed})` : ''}`;
  };
  const load = async (append = false) => {
    const rows = await listAuditLog({ before: append ? last : null, entity: body.querySelector('#audit-entity').value });
    last = rows.at(-1)?.id ?? last;
    const html = rows.map((row) => `<div class="list-row"><div><strong>${esc(describe(row))}</strong><small>${esc(row.profiles?.full_name || row.profiles?.email || t.system)} · ${esc(formatDateTime(row.created_at))}</small></div></div>`).join('');
    if (append) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html || emptyRow(t.noAuditEntries);
    more.hidden = rows.length < 50;
  };
  body.querySelector('#audit-entity').addEventListener('change', () => load().catch(toastError));
  more.addEventListener('click', () => load(true).catch(toastError));
  await load();
}

function compliance(body, ctx) {
  const { t } = ctx;
  const settings = workspace.org.settings || {};
  const form = formPanel(body, {
    t,
    fields: [
      { name: 'retention_days', label: t.retentionDays, type: 'number', min: 0, value: settings.retention_days ?? '', hint: t.retentionDaysHint },
      { name: 'pii_masking', label: t.piiMasking, type: 'checkbox', value: Boolean(settings.pii_masking), hint: t.piiMaskingHint, full: true },
    ],
    html: `
      <div class="danger-zone">
        <div><strong>${esc(t.exportAllData)}</strong><p>${esc(t.exportAllDataHelp)}</p><button type="button" class="ghost-btn" id="export-all">⇩ ${esc(t.exportAllData)}</button></div>
        ${can('owner') ? `<div><strong class="danger-text">${esc(t.deleteWorkspace)}</strong><p>${esc(t.deleteWorkspaceHelp)}</p><button type="button" class="ghost-btn danger-text" id="delete-workspace">${esc(t.deleteWorkspace)}</button></div>` : ''}
      </div>`,
    onSubmit: (values) => updateOrgSettings({ retention_days: values.retention_days || null, pii_masking: values.pii_masking }),
  });
  form.querySelector('#export-all').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const data = await exportWorkspaceData();
      download(`autexa-${workspace.org.name.replace(/\W+/g, '-').toLowerCase()}-export.json`, JSON.stringify(data, null, 2), 'application/json');
    } catch (error) { toastError(error); } finally { event.target.disabled = false; }
  });
  form.querySelector('#delete-workspace')?.addEventListener('click', () => openModal({
    title: t.deleteWorkspace,
    html: `<p class="danger-text">${esc(t.deleteWorkspaceConfirm)}</p>`,
    fields: [{ name: 'confirm', label: t.typeWorkspaceName.replace('{name}', workspace.org.name), required: true, full: true }],
    submitLabel: t.deleteForever,
    onMount: (modal) => modal.querySelector('[type="submit"]').classList.add('danger'),
    onSubmit: async (values) => {
      if (values.confirm !== workspace.org.name) throw new Error(t.nameDoesNotMatch);
      await deleteWorkspace();
      localStorage.removeItem('autexa-org');
      location.hash = '#/overview';
      ctx.rebootShell();
    },
  }));
}

function profile(body, ctx) {
  const { t } = ctx;
  formPanel(body, {
    t,
    fields: [
      { name: 'full_name', label: t.fullName, required: true, value: workspace.profile?.full_name },
      { name: 'email', label: t.email, value: workspace.profile?.email || workspace.user?.email, disabled: true },
      { name: 'password', label: t.newPassword, type: 'password', hint: t.newPasswordHint },
      { name: 'password_confirm', label: t.confirmPassword, type: 'password' },
    ],
    onSubmit: async (values) => {
      if (values.password) {
        if (values.password.length < 8) throw new Error(t.passwordTooShort);
        if (values.password !== values.password_confirm) throw new Error(t.passwordsDontMatch);
        await changePassword(values.password);
      }
      await updateProfile({ full_name: values.full_name });
    },
  });
}
