import { esc, options } from '../../lib/html.js';
import { timeAgo } from '../../lib/format.js';
import { confirmDialog, emptyRow, field, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import { ACTIONS, RECIPES, TRIGGERS, deleteAutomation, listAutomations, listRuns, saveAutomation } from '../../services/automations.js';
import { listServices } from '../../services/bookings.js';
import { getTemplates, templateVariableCount } from '../../services/templates.js';
import { can } from '../../services/workspace.js';

export function render({ t }) {
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.growthEyebrow)}</p><h1>${esc(t.automations)}</h1><p>${esc(t.automationsSubtitle)}</p></div>
      ${can('admin') ? `<div class="heading-actions"><button class="create" id="new-automation">＋ ${esc(t.newAutomation)}</button></div>` : ''}
    </div>
    ${can('admin') ? `<section class="recipe-grid">${RECIPES.map((recipe) => `<button class="recipe-card" data-recipe="${recipe.key}"><strong>${esc(t[`recipe_${recipe.key}`])}</strong><small>${esc(t[`recipe_${recipe.key}_desc`])}</small></button>`).join('')}</section>` : ''}
    <article class="panel table-panel"><div class="simple-list" id="automation-list">${loadingRow(t.loading)}</div></article>`;
}

const describeActions = (t, actions) => (actions || []).map((action) => t[`action_${action.type}`] || action.type).join(' → ');

export async function mount(root, ctx) {
  const { t } = ctx;
  const list = root.querySelector('#automation-list');
  let automations = [];
  root.querySelector('#new-automation')?.addEventListener('click', () => create(ctx));
  root.querySelectorAll('[data-recipe]').forEach((button) => button.addEventListener('click', () => {
    const recipe = RECIPES.find((item) => item.key === button.dataset.recipe);
    openAutomationForm(t, { name: t[`recipe_${recipe.key}`], trigger: recipe.trigger, delay_minutes: recipe.delay_minutes, actions: structuredClone(recipe.actions), conditions: {} }, () => ctx.refresh());
  }));
  try { automations = await listAutomations(); } catch (error) { list.innerHTML = emptyRow(error.message); return; }
  list.innerHTML = automations.length ? automations.map((item) => `
    <div class="list-row" data-id="${item.id}">
      <div><strong>${esc(item.name)}</strong>
        <small>${esc(t.when)}: ${esc(t[`trigger_${item.trigger}`])}${item.delay_minutes ? ` + ${esc(item.delay_minutes)} ${esc(t.minutesShort)}` : ''} · ${esc(t.then)}: ${esc(describeActions(t, item.actions))}</small>
        <small>${esc(t.runCount.replace('{count}', item.run_count))}${item.last_run_at ? ` · ${esc(t.lastRun)} ${esc(timeAgo(item.last_run_at))}` : ''}</small>
      </div>
      <div class="row-actions">
        ${can('admin') ? `<label class="switch-row"><input type="checkbox" data-toggle="${item.id}" ${item.is_active ? 'checked' : ''} /><span>${esc(item.is_active ? t.active : t.inactive)}</span></label>` : ''}
        <button class="ghost-btn" data-runs="${item.id}">${esc(t.history)}</button>
        ${can('admin') ? `<button class="ghost-btn" data-edit="${item.id}">${esc(t.edit)}</button><button class="ghost-btn danger-text" data-delete="${item.id}">${esc(t.delete)}</button>` : ''}
      </div>
    </div>`).join('') : emptyRow(t.noAutomations);
  list.addEventListener('change', async (event) => {
    const id = event.target.dataset.toggle;
    if (!id) return;
    try { await saveAutomation({ id, is_active: event.target.checked }); ctx.refresh(); } catch (error) { toastError(error); }
  });
  list.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-runs],[data-edit],[data-delete]');
    if (!target) return;
    const item = automations.find((entry) => entry.id === (target.dataset.runs || target.dataset.edit || target.dataset.delete));
    try {
      if (target.dataset.runs) openRuns(t, item);
      if (target.dataset.edit) openAutomationForm(t, item, () => ctx.refresh());
      if (target.dataset.delete && await confirmDialog(t.deleteConfirm)) { await deleteAutomation(item.id); ctx.refresh(); }
    } catch (error) { toastError(error); }
  });
}

async function openRuns(t, automation) {
  const { form } = openModal({ title: `${t.history}: ${automation.name}`, wide: true, hideSubmit: true, html: `<div id="runs-body">${loadingRow(t.loading)}</div>` });
  try {
    const runs = await listRuns(automation.id);
    form.querySelector('#runs-body').innerHTML = `<div class="simple-list scroll-list">${runs.map((run) => `
      <div class="list-row"><div><strong>${esc(run.customers?.full_name || run.customers?.phone || '—')}</strong><small>${esc(timeAgo(run.created_at))}${run.error ? ` · <span class="danger-text">${esc(run.error)}</span>` : ''}</small></div><span class="status ${run.status === 'done' ? 'resolved' : run.status === 'failed' ? 'cancelled' : 'scheduled'}">${esc(t[`runStatus_${run.status}`] || run.status)}</span></div>`).join('') || emptyRow(t.noRuns)}</div>`;
  } catch (error) { form.querySelector('#runs-body').innerHTML = emptyRow(error.message); }
}

function actionRow(t, action, index, templates) {
  const template = templates.find((item) => item.id === action.template_id);
  const variableCount = templateVariableCount(template?.body);
  let detail = '';
  if (action.type === 'send_template') {
    detail = `<select data-key="template_id" required><option value="">${esc(t.chooseTemplate)}</option>${options(templates.map((item) => [item.id, `${item.name} (${item.language})`]), action.template_id)}</select>
      ${Array.from({ length: variableCount }, (_, varIndex) => `<input data-var="${varIndex}" placeholder="{{${varIndex + 1}}}" value="${esc(action.variables?.[varIndex] ?? '')}" />`).join('')}`;
  }
  if (action.type === 'send_text') detail = `<textarea data-key="text" rows="2" required placeholder="${esc(t.messageText)}">${esc(action.text || '')}</textarea>`;
  if (action.type === 'add_tag' || action.type === 'remove_tag') detail = `<input data-key="tag" required placeholder="${esc(t.tag)}" value="${esc(action.tag || '')}" />`;
  if (action.type === 'create_handoff') detail = `<input data-key="reason" placeholder="${esc(t.handoffReason)}" value="${esc(action.reason || '')}" />`;
  return `<div class="action-row" data-index="${index}">
    <span class="step-number">${index + 1}</span>
    <select data-key="type">${options(ACTIONS.map((type) => [type, t[`action_${type}`]]), action.type)}</select>
    <div class="action-detail">${detail}</div>
    <button type="button" class="icon-btn" data-remove-action="${index}" aria-label="${esc(t.delete)}">✕</button>
  </div>`;
}

async function openAutomationForm(t, automation = {}, onSaved) {
  let templates = [];
  let services = [];
  try { [templates, services] = await Promise.all([getTemplates('approved'), listServices()]); } catch (error) { toastError(error); return; }
  let actions = structuredClone(automation.actions?.length ? automation.actions : [{ type: 'send_template', template_id: '', variables: [] }]);
  const conditions = automation.conditions || {};
  openModal({
    title: automation.id ? t.editAutomation : t.newAutomation,
    wide: true,
    fields: [
      { name: 'name', label: t.name, required: true, value: automation.name, full: true },
      { name: 'trigger', label: t.when, type: 'select', value: automation.trigger || 'booking_completed', options: TRIGGERS.map((trigger) => [trigger, t[`trigger_${trigger}`]]) },
      { name: 'delay_minutes', label: t.waitMinutes, type: 'number', min: 0, value: automation.delay_minutes ?? 0, hint: t.waitMinutesHint },
      { name: 'tags', label: t.onlyCustomersTagged, type: 'tags', value: conditions.tags || [] },
      { name: 'exclude_tags', label: t.excludeCustomersTagged, type: 'tags', value: conditions.exclude_tags || [] },
    ],
    html: `
      <div class="form-grid" id="trigger-extra"></div>
      <p class="muted-text" id="trigger-help"></p>
      <h3>${esc(t.then)}</h3>
      <div id="action-list" class="action-list"></div>
      <button type="button" class="ghost-btn" id="add-action">＋ ${esc(t.addAction)}</button>
      <p class="muted-text">${esc(t.automationVariablesHint)}</p>`,
    onMount: (form) => {
      const actionList = form.querySelector('#action-list');
      const readActions = () => {
        actions = [...actionList.querySelectorAll('.action-row')].map((row) => {
          const action = { type: row.querySelector('[data-key="type"]').value };
          row.querySelectorAll('.action-detail [data-key]').forEach((input) => { action[input.dataset.key] = input.value.trim(); });
          const vars = [...row.querySelectorAll('[data-var]')].map((input) => input.value.trim());
          if (action.type === 'send_template') action.variables = vars;
          return action;
        });
      };
      const renderActions = () => { actionList.innerHTML = actions.map((action, index) => actionRow(t, action, index, templates)).join(''); };
      const renderTrigger = () => {
        const trigger = form.querySelector('[name="trigger"]').value;
        form.querySelector('#trigger-help').textContent = t[`trigger_${trigger}_help`] || '';
        const extra = form.querySelector('#trigger-extra');
        if (trigger === 'booking_created' || trigger === 'booking_completed') {
          extra.innerHTML = `<div class="form-field full"><label>${esc(t.onlyServices)}</label><div class="chip-picker">${services.map((service) => `<label class="chip"><input type="checkbox" data-service value="${service.id}" ${(conditions.service_ids || []).includes(service.id) ? 'checked' : ''} /><span>${esc(service.name)}</span></label>`).join('') || `<small>${esc(t.noServices)}</small>`}</div></div>`;
        } else if (trigger === 'inquiry_abandoned') {
          extra.innerHTML = field({ name: 'intents', label: t.intents, type: 'tags', value: conditions.intents || ['booking', 'pricing', 'purchase'], hint: t.intentsHint, full: true });
        } else extra.innerHTML = '';
      };
      actionList.addEventListener('change', (event) => {
        if (event.target.matches('[data-key="type"], [data-key="template_id"]')) {
          readActions();
          const row = event.target.closest('.action-row');
          if (event.target.dataset.key === 'type') actions[Number(row.dataset.index)] = { type: event.target.value };
          renderActions();
        }
      });
      actionList.addEventListener('click', (event) => {
        const index = event.target.closest('[data-remove-action]')?.dataset.removeAction;
        if (index === undefined) return;
        readActions();
        actions.splice(Number(index), 1);
        renderActions();
      });
      form.querySelector('#add-action').addEventListener('click', () => { readActions(); actions.push({ type: 'add_tag', tag: '' }); renderActions(); });
      form.querySelector('[name="trigger"]').addEventListener('change', renderTrigger);
      form.readActions = () => { readActions(); return actions; };
      renderActions();
      renderTrigger();
    },
    onSubmit: async (values, form) => {
      const finalActions = form.readActions();
      if (!finalActions.length) throw new Error(t.addAtLeastOneAction);
      if (finalActions.some((action) => action.type === 'send_template' && !action.template_id)) throw new Error(t.chooseTemplate);
      await saveAutomation({
        id: automation.id,
        name: values.name,
        trigger: values.trigger,
        delay_minutes: values.delay_minutes || 0,
        conditions: {
          tags: values.tags,
          exclude_tags: values.exclude_tags,
          service_ids: [...form.querySelectorAll('[data-service]:checked')].map((input) => input.value),
          intents: values.intents || [],
        },
        actions: finalActions,
        is_active: automation.is_active ?? true,
      });
      toast(t.saved, 'success');
      onSaved?.();
    },
  });
}

export function create(ctx) {
  if (!can('admin')) return;
  openAutomationForm(ctx.t, {}, () => ctx.refresh());
}
