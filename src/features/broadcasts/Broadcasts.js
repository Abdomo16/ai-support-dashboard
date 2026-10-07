import { esc } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDateTime, formatNumber, toLocalInput } from '../../lib/format.js';
import { confirmDialog, emptyRow, field, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import {
  deleteBroadcast, estimateAudience, getRecipients, listBroadcasts, saveBroadcast, sendBroadcastNow,
} from '../../services/broadcasts.js';
import { fetchAllTags } from '../../services/customers.js';
import {
  deleteTemplate, getTemplates, saveTemplate, submitTemplate, syncTemplates, templateVariableCount,
} from '../../services/templates.js';
import { subscribe } from '../../services/supabaseClient.js';
import { can, orgId } from '../../services/workspace.js';

const tabs = ['campaigns', 'templates'];
const percent = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : '—');

export function render({ t, id }) {
  const tab = tabs.includes(id) ? id : 'campaigns';
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.growthEyebrow)}</p><h1>${esc(t.broadcasts)}</h1><p>${esc(t.broadcastsSubtitle)}</p></div>
      ${can('admin') ? `<div class="heading-actions">${tab === 'templates'
    ? `<button class="ghost-btn" id="sync-templates">↻ ${esc(t.syncFromWhatsApp)}</button><button class="create" id="new-template">＋ ${esc(t.newTemplate)}</button>`
    : `<button class="create" id="new-broadcast">＋ ${esc(t.newBroadcast)}</button>`}</div>` : ''}
    </div>
    <div class="page-tabs">${tabs.map((key) => `<a class="page-tab ${key === tab ? 'active' : ''}" href="${href('broadcasts', key === 'campaigns' ? null : key)}">${esc(t[`broadcastTab_${key}`])}</a>`).join('')}</div>
    <div id="broadcast-body">${loadingRow(t.loading)}</div>`;
}

export async function mount(root, ctx) {
  const { t, id } = ctx;
  const tab = tabs.includes(id) ? id : 'campaigns';
  const body = root.querySelector('#broadcast-body');
  root.querySelector('#new-broadcast')?.addEventListener('click', () => create(ctx));
  root.querySelector('#new-template')?.addEventListener('click', () => openTemplateForm(t, {}, () => ctx.refresh()));
  root.querySelector('#sync-templates')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { const { synced } = await syncTemplates(); toast(t.templatesSynced.replace('{count}', synced), 'success'); ctx.refresh(); } catch (error) { toastError(error); event.target.disabled = false; }
  });
  if (tab === 'templates') return mountTemplates(body, ctx);
  return mountCampaigns(body, ctx);
}

function mountCampaigns(body, ctx) {
  const { t } = ctx;
  body.innerHTML = `<article class="panel table-panel"><div class="simple-list" id="broadcast-list">${loadingRow(t.loading)}</div></article>`;
  const list = body.querySelector('#broadcast-list');
  let broadcasts = [];
  const load = async () => {
    try {
      broadcasts = await listBroadcasts();
      list.innerHTML = broadcasts.length ? broadcasts.map((item) => `
        <div class="list-row broadcast-row" data-id="${item.id}">
          <div>
            <strong>${esc(item.name)}</strong>
            <small>${esc(item.whatsapp_templates?.name || t.noTemplate)} · ${esc(item.segment?.tags?.length ? item.segment.tags.join(', ') : t.allCustomers)} · ${esc(item.sent_at ? formatDateTime(item.sent_at) : item.scheduled_at ? `${t.scheduledFor} ${formatDateTime(item.scheduled_at)}` : formatDateTime(item.created_at))}</small>
          </div>
          <div class="broadcast-stats">
            ${[[t.recipients, formatNumber(item.total)], [t.delivered, percent(item.delivered, item.sent)], [t.readRate, percent(item.read, item.sent)], [t.replied, percent(item.replied, item.sent)], [t.failed, formatNumber(item.failed)]]
    .map(([label, value]) => `<span><b>${esc(value)}</b>${esc(label)}</span>`).join('')}
          </div>
          <div class="row-actions">
            <span class="status ${esc(item.status)}">${esc(t[`broadcastStatus_${item.status}`] || item.status)}</span>
            ${can('admin') && ['draft', 'scheduled'].includes(item.status) ? `<button class="create small" data-send="${item.id}">${esc(t.sendNow)}</button><button class="ghost-btn" data-edit="${item.id}">${esc(t.edit)}</button>` : ''}
            ${item.status !== 'draft' ? `<button class="ghost-btn" data-report="${item.id}">${esc(t.report)}</button>` : ''}
            ${can('admin') && item.status !== 'sending' ? `<button class="ghost-btn danger-text" data-delete="${item.id}">${esc(t.delete)}</button>` : ''}
          </div>
        </div>`).join('') : emptyRow(t.noBroadcasts);
    } catch (error) { list.innerHTML = emptyRow(error.message); }
  };
  list.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-send],[data-edit],[data-report],[data-delete]');
    if (!target) return;
    const item = broadcasts.find((entry) => entry.id === (target.dataset.send || target.dataset.edit || target.dataset.report || target.dataset.delete));
    try {
      if (target.dataset.send && await confirmDialog(t.sendBroadcastConfirm.replace('{name}', item.name), { danger: false, confirmLabel: t.sendNow })) {
        await sendBroadcastNow(item.id);
        toast(t.broadcastStarted, 'success');
        load();
      }
      if (target.dataset.edit) openBroadcastForm(t, item, load);
      if (target.dataset.report) openReport(t, item);
      if (target.dataset.delete && await confirmDialog(t.deleteConfirm)) { await deleteBroadcast(item.id); load(); }
    } catch (error) { toastError(error); }
  });
  load();
  const unsubscribe = subscribe({ table: 'broadcasts', filter: `org_id=eq.${orgId()}` }, () => load());
  return unsubscribe;
}

async function openReport(t, broadcast) {
  const { form } = openModal({ title: `${t.report}: ${broadcast.name}`, wide: true, hideSubmit: true, html: `<div id="report-body">${loadingRow(t.loading)}</div>` });
  try {
    const rows = await getRecipients(broadcast.id);
    form.querySelector('#report-body').innerHTML = `
      <div class="funnel">${[[t.recipients, broadcast.total], [t.sent, broadcast.sent], [t.delivered, broadcast.delivered], [t.readRate, broadcast.read], [t.replied, broadcast.replied]]
    .map(([label, value]) => `<div class="funnel-step"><b>${esc(formatNumber(value))}</b><span>${esc(label)}</span><i style="width:${broadcast.total ? Math.max(4, (value / broadcast.total) * 100) : 0}%"></i></div>`).join('')}</div>
      <div class="simple-list scroll-list">${rows.map((row) => `<div class="list-row"><div><strong>${esc(row.customers?.full_name || row.customers?.phone || '—')}</strong><small>${esc(row.customers?.phone || '')}${row.error ? ` · <span class="danger-text">${esc(row.error)}</span>` : ''}</small></div><span class="status ${esc(row.status)}">${esc(t[`recipientStatus_${row.status}`] || row.status)}</span></div>`).join('') || emptyRow(t.noRecipients)}</div>`;
  } catch (error) { form.querySelector('#report-body').innerHTML = emptyRow(error.message); }
}

async function openBroadcastForm(t, broadcast = {}, onSaved) {
  let templates = [];
  let tags = [];
  try { [templates, tags] = await Promise.all([getTemplates('approved'), fetchAllTags()]); } catch (error) { toastError(error); return; }
  if (!templates.length) { toast(t.needApprovedTemplate, 'error'); return; }
  const selectedTags = broadcast.segment?.tags || [];
  openModal({
    title: broadcast.id ? t.editBroadcast : t.newBroadcast,
    wide: true,
    fields: [
      { name: 'name', label: t.campaignName, required: true, value: broadcast.name, full: true },
      { name: 'template_id', label: t.template, type: 'select', required: true, value: broadcast.template_id, options: templates.map((item) => [item.id, `${item.name} (${item.language}, ${item.category.toLowerCase()})`]), full: true },
    ],
    html: `
      <div id="template-preview" class="template-preview"></div>
      <div id="variable-fields" class="form-grid"></div>
      <div class="form-field full"><label>${esc(t.audience)}</label>
        <div class="chip-picker" id="tag-picker">${tags.length ? tags.map((tag) => `<label class="chip"><input type="checkbox" value="${esc(tag)}" ${selectedTags.includes(tag) ? 'checked' : ''} /><span>${esc(tag)}</span></label>`).join('') : `<small>${esc(t.noTagsYet)}</small>`}</div>
        <small>${esc(t.audienceHint)}</small>
      </div>
      <div class="form-grid">
        ${field({ name: 'opted_in_only', label: t.optedInOnly, type: 'checkbox', value: broadcast.segment?.opted_in_only !== false, hint: t.optedInOnlyHint })}
        ${field({ name: 'scheduled_at', label: t.scheduleFor, type: 'datetime-local', value: broadcast.scheduled_at ? toLocalInput(broadcast.scheduled_at) : '', hint: t.scheduleHint })}
      </div>
      <p class="audience-estimate" id="audience-estimate"></p>`,
    submitLabel: t.saveBroadcast,
    onMount: (form) => {
      const renderTemplate = () => {
        const template = templates.find((item) => item.id === form.querySelector('[name="template_id"]').value);
        const count = templateVariableCount(template?.body);
        form.querySelector('#template-preview').innerHTML = template ? `<div class="bubble out"><p>${esc(template.body)}</p></div>` : '';
        form.querySelector('#variable-fields').innerHTML = Array.from({ length: count }, (_, index) => field({
          name: `var_${index}`, label: `{{${index + 1}}}`, value: broadcast.variables?.[index] ?? (index === 0 ? '{first_name}' : ''), required: true, hint: index === 0 ? t.variableHint : '',
        })).join('');
      };
      const estimate = async () => {
        const output = form.querySelector('#audience-estimate');
        output.textContent = `${t.estimating}…`;
        try {
          const { count } = await estimateAudience(segmentOf(form));
          output.textContent = t.audienceCount.replace('{count}', formatNumber(count));
        } catch (error) { output.textContent = error.message; }
      };
      form.querySelector('[name="template_id"]').addEventListener('change', renderTemplate);
      form.querySelector('#tag-picker').addEventListener('change', estimate);
      form.querySelector('[name="opted_in_only"]').addEventListener('change', estimate);
      renderTemplate();
      estimate();
    },
    onSubmit: async (values, form) => {
      const variables = Object.keys(values).filter((key) => key.startsWith('var_')).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))).map((key) => values[key]);
      const scheduledAt = values.scheduled_at ? new Date(values.scheduled_at) : null;
      if (scheduledAt && scheduledAt < new Date()) throw new Error(t.scheduleInPast);
      await saveBroadcast({
        id: broadcast.id,
        name: values.name,
        template_id: values.template_id,
        variables,
        segment: segmentOf(form),
        scheduled_at: scheduledAt?.toISOString() ?? null,
        status: scheduledAt ? 'scheduled' : 'draft',
      });
      toast(scheduledAt ? t.broadcastScheduled : t.broadcastSaved, 'success');
      onSaved?.();
    },
  });
}

const segmentOf = (form) => ({
  tags: [...form.querySelectorAll('#tag-picker input:checked')].map((input) => input.value),
  opted_in_only: form.querySelector('[name="opted_in_only"]').checked,
});

async function mountTemplates(body, ctx) {
  const { t } = ctx;
  body.innerHTML = `<article class="panel table-panel"><div class="table-toolbar"><span class="source">${esc(t.templatesHelp)}</span></div><div class="simple-list" id="template-list">${loadingRow(t.loading)}</div></article>`;
  const list = body.querySelector('#template-list');
  let templates = [];
  try { templates = await getTemplates(); } catch (error) { list.innerHTML = emptyRow(error.message); return; }
  list.innerHTML = templates.length ? templates.map((item) => `
    <div class="list-row">
      <div><strong>${esc(item.name)} <span class="tag tag-light">${esc(item.language)}</span> <span class="tag">${esc(item.category)}</span></strong>
      <small>${esc(item.body.slice(0, 180))}</small>${item.rejection_reason ? `<small class="danger-text">${esc(t.rejectionReason)}: ${esc(item.rejection_reason)}</small>` : ''}</div>
      <div class="row-actions">
        <span class="status ${esc(item.status)}">${esc(t[`templateStatus_${item.status}`] || item.status)}</span>
        ${can('admin') && ['draft', 'rejected'].includes(item.status) ? `<button class="create small" data-submit="${item.id}">${esc(t.submitForApproval)}</button>` : ''}
        ${can('admin') ? `<button class="ghost-btn" data-edit="${item.id}">${esc(t.edit)}</button><button class="ghost-btn danger-text" data-delete="${item.id}">${esc(t.delete)}</button>` : ''}
      </div>
    </div>`).join('') : emptyRow(t.noTemplates);
  list.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-submit],[data-edit],[data-delete]');
    if (!target) return;
    const item = templates.find((entry) => entry.id === (target.dataset.submit || target.dataset.edit || target.dataset.delete));
    try {
      if (target.dataset.submit) { target.disabled = true; await submitTemplate(item.id); toast(t.templateSubmitted, 'success'); ctx.refresh(); }
      if (target.dataset.edit) openTemplateForm(t, item, () => ctx.refresh());
      if (target.dataset.delete && await confirmDialog(t.deleteConfirm)) { await deleteTemplate(item.id); ctx.refresh(); }
    } catch (error) { toastError(error); target.disabled = false; }
  });
  return undefined;
}

function openTemplateForm(t, template = {}, onSaved) {
  const buttons = template.buttons || [];
  openModal({
    title: template.id ? t.editTemplate : t.newTemplate,
    wide: true,
    html: template.status === 'approved' ? `<p class="banner warning">${esc(t.editApprovedWarning)}</p>` : '',
    fields: [
      { name: 'name', label: t.templateName, required: true, value: template.name, placeholder: 'order_update', hint: t.templateNameHint },
      { name: 'language', label: t.language, type: 'select', value: template.language || 'ar', options: [['ar', 'العربية (ar)'], ['en', 'English (en)'], ['en_US', 'English US (en_US)'], ['fr', 'Français (fr)']] },
      { name: 'category', label: t.category, type: 'select', value: template.category || 'MARKETING', options: [['MARKETING', t.categoryMarketing], ['UTILITY', t.categoryUtility], ['AUTHENTICATION', t.categoryAuthentication]] },
      { name: 'header_text', label: t.headerText, value: template.header_text },
      { name: 'body', label: t.templateBody, type: 'textarea', required: true, rows: 5, value: template.body, hint: t.templateBodyHint },
      { name: 'footer', label: t.footerText, value: template.footer },
      { name: 'buttons', label: t.quickReplyButtons, type: 'tags', value: buttons.filter((button) => button.type === 'QUICK_REPLY').map((button) => button.text), hint: t.quickReplyHint },
      { name: 'url_button_text', label: t.urlButtonText, value: buttons.find((button) => button.type === 'URL')?.text },
      { name: 'url_button_url', label: t.urlButtonUrl, type: 'url', value: buttons.find((button) => button.type === 'URL')?.url },
    ],
    onSubmit: async (values) => {
      const name = values.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      const nextButtons = values.buttons.slice(0, 3).map((text) => ({ type: 'QUICK_REPLY', text: text.slice(0, 25) }));
      if (values.url_button_text && values.url_button_url) nextButtons.push({ type: 'URL', text: values.url_button_text.slice(0, 25), url: values.url_button_url });
      await saveTemplate({
        id: template.id, name, language: values.language, category: values.category,
        header_text: values.header_text || null, body: values.body, footer: values.footer || null, buttons: nextButtons,
      });
      toast(t.saved, 'success');
      onSaved?.();
    },
  });
}

export function create(ctx) {
  if (!can('admin')) return;
  openBroadcastForm(ctx.t, {}, () => ctx.refresh());
}
