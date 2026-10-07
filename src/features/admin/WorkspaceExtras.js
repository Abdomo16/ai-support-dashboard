import { esc } from '../../lib/html.js';
import { timeAgo } from '../../lib/format.js';
import { confirmDialog, emptyRow, openModal, toast, toastError } from '../../lib/ui.js';
import { TOGGLEABLE_ROUTES } from '../../app/routes.js';
import { db, query } from '../../services/supabaseClient.js';

export async function openBasePrompt(t) {
  let current;
  try { [current] = await query('platform_settings', 'select=*&key=eq.ai_base_prompt'); } catch (error) { toastError(error); return; }
  openModal({
    title: t.basePrompt,
    wide: true,
    html: `<p class="muted-text">${esc(t.basePromptHelp)}</p>${current ? `<p class="small-text">${esc(t.version)} ${esc(current.version)} · ${esc(timeAgo(current.updated_at))}</p>` : ''}`,
    fields: [{ name: 'value', label: t.basePrompt, type: 'textarea', rows: 22, required: true, value: current?.value || '', full: true }],
    onSubmit: async (values) => {
      await db.insert('platform_settings', { key: 'ai_base_prompt', value: values.value }, { upsert: true, onConflict: 'key' });
      toast(t.saved, 'success');
    },
  });
}

const actionRow = (t, action) => `<div class="list-row"><div><strong>${esc(action.name)}</strong><small>${esc(action.ai_description)}</small><small class="mono">${esc(action.n8n_workflow_id)}</small></div>
  <div class="row-actions"><span class="status ${action.enabled ? 'resolved' : 'pending'}">${esc(action.enabled ? t.active : t.inactive)}</span><button type="button" class="ghost-btn danger-text" data-del-action="${action.id}">${esc(t.delete)}</button></div></div>`;
const jobRow = (t, job) => `<div class="list-row"><div><strong>${esc(job.name)}</strong><small>${esc(job.schedule_text || '')} · <span class="mono">${esc(job.n8n_workflow_id)}</span></small></div>
  <div class="row-actions"><button type="button" class="ghost-btn danger-text" data-del-job="${job.id}">${esc(t.delete)}</button></div></div>`;

export async function openExtras(t, tenant, onSaved) {
  let extras;
  try { extras = await db.rpc('admin_org_extras', { p_org: tenant.id }); } catch (error) { toastError(error); return; }
  const features = extras.features || {};
  const { form } = openModal({
    title: `${t.workspaceExtras}: ${tenant.name}`,
    wide: true,
    html: `
      <h3>${esc(t.pagesEnabled)}</h3>
      <div class="chip-picker">${TOGGLEABLE_ROUTES.map((route) => `<label class="chip"><input type="checkbox" data-feature="${route}" ${features[route] === false ? '' : 'checked'} /><span>${esc(t[route === 'data' ? 'dataSources' : route] || route)}</span></label>`).join('')}</div>
      <div class="form-grid">
        <div class="form-field full"><label>${esc(t.extraFeatures)}</label><textarea name="features_json" rows="3" class="mono">${esc(JSON.stringify(Object.fromEntries(Object.entries(features).filter(([key]) => !TOGGLEABLE_ROUTES.includes(key))), null, 2))}</textarea><small>${esc(t.extraFeaturesHint)}</small></div>
        <div class="form-field"><label>${esc(t.aiEngine)}</label><select name="engine"><option value="n8n" ${extras.engine !== 'edge' ? 'selected' : ''}>n8n</option><option value="edge" ${extras.engine === 'edge' ? 'selected' : ''}>Edge function</option></select></div>
        <div class="form-field"><label>${esc(t.workflowKey)}</label><input name="workflow_key" value="${esc(extras.workflow_key || 'shared')}" /><small>${esc(t.workflowKeyHint)}</small></div>
        <div class="form-field full"><label>${esc(t.promptOverride)}</label><textarea name="prompt_override" rows="6">${esc(extras.prompt_override || '')}</textarea><small>${esc(t.promptOverrideHint)}</small></div>
      </div>
      <h3>${esc(t.customActions)}</h3>
      <div class="simple-list" id="action-list">${(extras.custom_actions || []).map((action) => actionRow(t, action)).join('') || emptyRow(t.noCustomActions)}</div>
      <div class="form-grid" id="new-action">
        <div class="form-field"><label>${esc(t.name)}</label><input data-new-action="name" placeholder="request_callback" /></div>
        <div class="form-field"><label>${esc(t.n8nWorkflowId)}</label><input data-new-action="n8n_workflow_id" /></div>
        <div class="form-field full"><label>${esc(t.aiDescription)}</label><input data-new-action="ai_description" placeholder="${esc(t.customActionDescPlaceholder)}" /></div>
        <div class="form-field full"><label>${esc(t.actionInputs)}</label><input data-new-action="input_schema" class="mono" placeholder='{"preferred_time":"text"}' /></div>
        <button type="button" class="ghost-btn" id="add-action">＋ ${esc(t.addCustomAction)}</button>
      </div>
      <h3>${esc(t.scheduledTasks)}</h3>
      <div class="simple-list" id="job-list">${(extras.automation_jobs || []).map((job) => jobRow(t, job)).join('') || emptyRow(t.noScheduledTasks)}</div>
      <div class="form-grid">
        <div class="form-field"><label>${esc(t.name)}</label><input data-new-job="name" /></div>
        <div class="form-field"><label>${esc(t.n8nWorkflowId)}</label><input data-new-job="n8n_workflow_id" /></div>
        <div class="form-field"><label>${esc(t.schedule)}</label><input data-new-job="schedule_text" placeholder="${esc(t.schedulePlaceholder)}" /></div>
        <div class="form-field"><label>${esc(t.description)}</label><input data-new-job="description" /></div>
        <button type="button" class="ghost-btn" id="add-job">＋ ${esc(t.addScheduledTask)}</button>
      </div>`,
    onSubmit: async (values, modal) => {
      let extra = {};
      if (values.features_json) {
        try { extra = JSON.parse(values.features_json); } catch { throw new Error(t.invalidJson); }
      }
      const next = { ...extra };
      modal.querySelectorAll('[data-feature]').forEach((input) => { if (!input.checked) next[input.dataset.feature] = false; });
      await db.rpc('admin_set_org_features', { p_org: tenant.id, p_features: next });
      await db.rpc('admin_set_ai_routing', { p_org: tenant.id, p_engine: values.engine, p_workflow_key: values.workflow_key || 'shared' });
      if (values.prompt_override) await db.insert('ai_prompt_overrides', { org_id: tenant.id, prompt: values.prompt_override }, { upsert: true, onConflict: 'org_id' });
      else await db.remove('ai_prompt_overrides', `org_id=eq.${tenant.id}`);
      toast(t.saved, 'success');
      onSaved?.();
    },
  });

  const read = (attr) => Object.fromEntries([...form.querySelectorAll(`[${attr}]`)].map((input) => [input.getAttribute(attr), input.value.trim()]));
  const clear = (attr) => form.querySelectorAll(`[${attr}]`).forEach((input) => { input.value = ''; });
  form.querySelector('#add-action').addEventListener('click', async () => {
    const values = read('data-new-action');
    if (!values.name || !values.n8n_workflow_id || !values.ai_description) { toastError(new Error(t.fillActionFields)); return; }
    try {
      const schema = values.input_schema ? JSON.parse(values.input_schema) : {};
      const [row] = await db.insert('custom_actions', { org_id: tenant.id, ...values, input_schema: schema });
      form.querySelector('#action-list').querySelector('.loading-row')?.remove();
      form.querySelector('#action-list').insertAdjacentHTML('beforeend', actionRow(t, row));
      clear('data-new-action');
    } catch (error) { toastError(error instanceof SyntaxError ? new Error(t.invalidJson) : error); }
  });
  form.querySelector('#add-job').addEventListener('click', async () => {
    const values = read('data-new-job');
    if (!values.name || !values.n8n_workflow_id) { toastError(new Error(t.fillActionFields)); return; }
    try {
      const [row] = await db.insert('automation_jobs', { org_id: tenant.id, ...values });
      form.querySelector('#job-list').querySelector('.loading-row')?.remove();
      form.querySelector('#job-list').insertAdjacentHTML('beforeend', jobRow(t, row));
      clear('data-new-job');
    } catch (error) { toastError(error); }
  });
  form.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-del-action],[data-del-job]');
    if (!target || !await confirmDialog(t.deleteConfirm)) return;
    try {
      if (target.dataset.delAction) await db.remove('custom_actions', `id=eq.${target.dataset.delAction}`);
      if (target.dataset.delJob) await db.remove('automation_jobs', `id=eq.${target.dataset.delJob}`);
      target.closest('.list-row').remove();
    } catch (error) { toastError(error); }
  });
}
