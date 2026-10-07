import { esc, options } from '../../lib/html.js';
import { formatNumber, timeAgo } from '../../lib/format.js';
import { confirmDialog, emptyRow, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import {
  MAX_IMPORT_ROWS, deleteSource, listSources, previewRecords, readWorkbook, replaceRecords, requestSync, saveSource, searchRecords,
} from '../../services/dataSources.js';
import { subscribe } from '../../services/supabaseClient.js';
import { can, orgId, workspace } from '../../services/workspace.js';

const KIND_ICON = { excel: '▦', google_sheet: '▤', database: '⛁', api: '⇄' };
const STATUS_CLASS = { active: 'resolved', syncing: 'scheduled', pending_setup: 'pending', error: 'cancelled', paused: 'pending' };

export function render({ t }) {
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.aiGroup)}</p><h1>${esc(t.dataSources)}</h1><p>${esc(t.dataSourcesSubtitle)}</p></div>
      ${can('admin') ? `<div class="heading-actions">
        <button class="ghost-btn" id="add-connector">⛁ ${esc(t.connectSystem)}</button>
        <button class="ghost-btn" id="add-sheet">▤ ${esc(t.connectGoogleSheet)}</button>
        <button class="create" id="add-excel">＋ ${esc(t.uploadExcel)}</button>
      </div>` : ''}
    </div>
    <article class="panel">
      <div class="panel-head"><div><h2>${esc(t.testAiSearch)}</h2><p>${esc(t.testAiSearchHelp)}</p></div></div>
      <form class="inline-form" id="test-search"><input type="search" name="q" placeholder="${esc(t.testAiSearchPlaceholder)}" required /><button class="create" type="submit">${esc(t.searchAction)}</button></form>
      <div id="test-results"></div>
    </article>
    <article class="panel table-panel"><div class="simple-list" id="source-list">${loadingRow(t.loading)}</div></article>`;
}

export async function mount(root, ctx) {
  const { t } = ctx;
  const list = root.querySelector('#source-list');
  let sources = [];

  const draw = () => {
    list.innerHTML = sources.length ? sources.map((source) => `
      <div class="list-row" data-id="${source.id}">
        <div>
          <strong>${KIND_ICON[source.kind] || '•'} ${esc(source.name)} <span class="tag">${esc(t[`sourceKind_${source.kind}`] || source.kind)}</span>${source.config?.mode === 'live' ? ` <span class="tag">${esc(t.liveLookup)}</span>` : ''}</strong>
          <small>${esc(source.ai_description || t.noAiDescription)}</small>
          <small>${esc(t.rowCount.replace('{count}', formatNumber(source.row_count || 0)))}${source.last_sync_at ? ` · ${esc(t.lastSync)} ${esc(timeAgo(source.last_sync_at))}` : ''}${source.error ? ` · <span class="danger-text">${esc(source.error)}</span>` : ''}</small>
        </div>
        <div class="row-actions">
          <span class="status ${STATUS_CLASS[source.status] || 'pending'}">${esc(t[`sourceStatus_${source.status}`] || source.status)}</span>
          <button class="ghost-btn" data-preview="${source.id}">${esc(t.preview)}</button>
          ${can('admin') && source.kind === 'google_sheet' ? `<button class="ghost-btn" data-sync="${source.id}">${esc(t.syncNow)}</button>` : ''}
          ${can('admin') && source.kind === 'excel' ? `<button class="ghost-btn" data-reupload="${source.id}">${esc(t.replaceFile)}</button>` : ''}
          ${can('admin') ? `<button class="ghost-btn" data-edit="${source.id}">${esc(t.edit)}</button><button class="ghost-btn danger-text" data-delete="${source.id}">${esc(t.delete)}</button>` : ''}
        </div>
      </div>`).join('') : emptyRow(t.noDataSources);
  };
  const load = async () => {
    try { sources = await listSources(); draw(); } catch (error) { list.innerHTML = emptyRow(error.message); }
  };

  root.querySelector('#add-excel')?.addEventListener('click', () => openExcelImport(t, null, load));
  root.querySelector('#add-sheet')?.addEventListener('click', () => openSheetForm(t, null, load));
  root.querySelector('#add-connector')?.addEventListener('click', () => openConnectorForm(t, null, load));

  root.querySelector('#test-search').addEventListener('submit', async (event) => {
    event.preventDefault();
    const box = root.querySelector('#test-results');
    const text = event.target.q.value.trim();
    if (!text) return;
    box.innerHTML = loadingRow(t.loading);
    try {
      const hits = await searchRecords(text);
      box.innerHTML = hits.length ? recordsTable(hits.map((hit) => hit.data), hits.map((hit) => hit.source)) : emptyRow(t.noMatches);
    } catch (error) { box.innerHTML = emptyRow(error.message); }
  });

  list.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-preview],[data-sync],[data-reupload],[data-edit],[data-delete]');
    if (!target) return;
    const source = sources.find((item) => item.id === Object.values(target.dataset)[0]);
    try {
      if (target.dataset.preview) openPreview(t, source);
      if (target.dataset.sync) { await requestSync(source.id); toast(t.syncQueued, 'success'); load(); }
      if (target.dataset.reupload) openExcelImport(t, source, load);
      if (target.dataset.edit) {
        if (source.kind === 'excel') openEditForm(t, source, load);
        else if (source.kind === 'google_sheet') openSheetForm(t, source, load);
        else openConnectorForm(t, source, load);
      }
      if (target.dataset.delete && await confirmDialog(t.deleteSourceConfirm)) { await deleteSource(source.id); toast(t.deleted, 'success'); load(); }
    } catch (error) { toastError(error); }
  });

  await load();
  const unsubscribe = subscribe({ table: 'data_sources', filter: `org_id=eq.${orgId()}` }, () => load());
  return () => unsubscribe?.();
}

function recordsTable(rows, sources = []) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))].slice(0, 12);
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${sources.length ? '<th></th>' : ''}${columns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row, index) => `<tr>${sources.length ? `<td><span class="tag">${esc(sources[index])}</span></td>` : ''}${columns.map((column) => `<td>${esc(String(row?.[column] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

async function openPreview(t, source) {
  const { form } = openModal({ title: `${t.preview}: ${source.name}`, wide: true, hideSubmit: true, html: `<div id="preview-body">${loadingRow(t.loading)}</div>` });
  try {
    const rows = await previewRecords(source.id);
    form.querySelector('#preview-body').innerHTML = rows.length ? recordsTable(rows.map((row) => row.data)) : emptyRow(t.noRowsYet);
  } catch (error) { form.querySelector('#preview-body').innerHTML = emptyRow(error.message); }
}

const descriptionField = (t, value) => ({ name: 'ai_description', label: t.aiDescription, type: 'textarea', rows: 2, value, hint: t.aiDescriptionHint, full: true });
const adminWorkflowField = (t, source) => (workspace.isPlatformAdmin
  ? [{ name: 'n8n_workflow_id', label: t.n8nWorkflowId, value: source?.n8n_workflow_id || '', hint: t.n8nWorkflowIdHint }] : []);

function openExcelImport(t, existing, onSaved) {
  let sheets = [];
  const renderMapping = (form) => {
    const sheet = sheets.find((item) => item.name === form.querySelector('[name="sheet"]')?.value) || sheets[0];
    const box = form.querySelector('#mapping');
    if (!sheet) { box.innerHTML = ''; return; }
    const keep = existing?.config?.columns;
    box.innerHTML = `
      ${sheets.length > 1 ? `<div class="form-field"><label>${esc(t.sheet)}</label><select name="sheet">${options(sheets.map((item) => [item.name, item.name]), sheet.name)}</select></div>` : `<input type="hidden" name="sheet" value="${esc(sheet.name)}" />`}
      <div class="form-field"><label>${esc(t.keyColumn)}</label><select name="key_column">${options([['', t.rowNumber], ...sheet.headers.map((header) => [header, header])], existing?.config?.key_column || '')}</select><small>${esc(t.keyColumnHint)}</small></div>
      <div class="form-field full"><label>${esc(t.columnsForAi)}</label><div class="chip-picker">${sheet.headers.map((header) => `<label class="chip"><input type="checkbox" data-column value="${esc(header)}" ${!keep || keep.includes(header) ? 'checked' : ''} /><span>${esc(header)}</span></label>`).join('')}</div></div>
      <p class="muted-text full">${esc(t.rowsFound.replace('{count}', formatNumber(sheet.rows.length)))}${sheet.rows.length > MAX_IMPORT_ROWS ? ` · ${esc(t.rowsTruncated.replace('{max}', formatNumber(MAX_IMPORT_ROWS)))}` : ''}</p>
      <div class="full">${recordsTable(sheet.rows.slice(0, 5))}</div>`;
    box.querySelector('[name="sheet"]')?.addEventListener('change', () => renderMapping(form));
  };
  openModal({
    title: existing ? `${t.replaceFile}: ${existing.name}` : t.uploadExcel,
    wide: true,
    fields: [
      ...(existing ? [] : [{ name: 'name', label: t.name, required: true, placeholder: t.sourceNamePlaceholder }]),
      { name: 'file', label: t.excelFile, type: 'file', accept: '.xlsx,.xls,.csv,.ods', required: true, hint: t.excelFileHint },
      ...(existing ? [] : [descriptionField(t, '')]),
    ],
    html: '<div class="form-grid" id="mapping"></div>',
    submitLabel: t.import,
    onMount: (form) => {
      form.querySelector('[name="file"]').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        const box = form.querySelector('#mapping');
        if (!file) return;
        box.innerHTML = loadingRow(t.readingFile);
        try {
          sheets = await readWorkbook(file);
          if (!sheets.some((sheet) => sheet.rows.length)) throw new Error(t.csvEmpty);
          sheets = sheets.filter((sheet) => sheet.rows.length);
          renderMapping(form);
        } catch (error) { sheets = []; box.innerHTML = emptyRow(error.message); }
      });
    },
    onSubmit: async (values, form) => {
      const sheet = sheets.find((item) => item.name === values.sheet) || sheets[0];
      if (!sheet) throw new Error(t.chooseFileFirst);
      const columns = [...form.querySelectorAll('[data-column]:checked')].map((input) => input.value);
      if (!columns.length) throw new Error(t.chooseColumns);
      const rows = sheet.rows.slice(0, MAX_IMPORT_ROWS).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
      const config = { file_name: values.file?.name, sheet: sheet.name, columns, key_column: values.key_column || '' };
      const source = existing
        ? await saveSource({ id: existing.id, config: { ...existing.config, ...config }, status: 'syncing' })
        : await saveSource({ kind: 'excel', name: values.name, ai_description: values.ai_description, config, status: 'syncing' });
      const count = await replaceRecords(source.id, rows, values.key_column);
      toast(t.importedRows.replace('{count}', formatNumber(count)), 'success');
      onSaved();
    },
  });
}

function openEditForm(t, source, onSaved) {
  openModal({
    title: `${t.edit}: ${source.name}`,
    fields: [
      { name: 'name', label: t.name, required: true, value: source.name },
      { name: 'status', label: t.status, type: 'select', value: source.status === 'paused' ? 'paused' : 'active', options: [['active', t.sourceStatus_active], ['paused', t.sourceStatus_paused]] },
      descriptionField(t, source.ai_description),
      ...adminWorkflowField(t, source),
    ],
    onSubmit: async (values) => { await saveSource({ id: source.id, ...values }); toast(t.saved, 'success'); onSaved(); },
  });
}

function openSheetForm(t, existing, onSaved) {
  openModal({
    title: existing ? `${t.edit}: ${existing.name}` : t.connectGoogleSheet,
    html: `<p class="muted-text">${esc(t.googleSheetHelp)}</p>`,
    fields: [
      { name: 'name', label: t.name, required: true, value: existing?.name, placeholder: t.sourceNamePlaceholder },
      { name: 'sheet_url', label: t.googleSheetUrl, type: 'url', required: true, value: existing?.config?.sheet_url, placeholder: 'https://docs.google.com/spreadsheets/d/…', full: true },
      { name: 'key_column', label: t.keyColumn, value: existing?.config?.key_column, hint: t.keyColumnHint },
      { name: 'sync_interval_minutes', label: t.syncEveryMinutes, type: 'number', min: 5, value: existing?.sync_interval_minutes ?? 15 },
      descriptionField(t, existing?.ai_description || ''),
    ],
    submitLabel: existing ? t.save : t.connect,
    onSubmit: async (values) => {
      if (!/docs\.google\.com\/spreadsheets\/d\//.test(values.sheet_url)) throw new Error(t.invalidSheetUrl);
      await saveSource({
        id: existing?.id, kind: 'google_sheet', name: values.name, ai_description: values.ai_description,
        sync_interval_minutes: values.sync_interval_minutes || 15,
        config: { ...(existing?.config || {}), sheet_url: values.sheet_url, key_column: values.key_column },
        status: 'active', last_sync_at: null, error: null,
      });
      toast(t.syncQueued, 'success');
      onSaved();
    },
  });
}

function openConnectorForm(t, existing, onSaved) {
  const config = existing?.config || {};
  openModal({
    title: existing ? `${t.edit}: ${existing.name}` : t.connectSystem,
    wide: true,
    html: `<p class="muted-text">${esc(t.connectSystemHelp)}</p>`,
    fields: [
      { name: 'name', label: t.name, required: true, value: existing?.name, placeholder: t.connectorNamePlaceholder },
      { name: 'kind', label: t.systemType, type: 'select', value: existing?.kind || 'database', options: [['database', t.sourceKind_database], ['api', t.sourceKind_api]] },
      { name: 'mode', label: t.connectorMode, type: 'select', value: config.mode || 'sync', options: [['sync', t.connectorMode_sync], ['live', t.connectorMode_live]], hint: t.connectorModeHint },
      { name: 'system', label: t.systemName, value: config.system, placeholder: t.systemNamePlaceholder },
      { name: 'base_url', label: t.apiBaseUrl, value: config.base_url, placeholder: 'https://api.example.com' },
      { name: 'details', label: t.connectionDetails, type: 'textarea', rows: 4, value: config.details, hint: t.connectionDetailsHint, full: true },
      descriptionField(t, existing?.ai_description || ''),
      ...adminWorkflowField(t, existing),
    ],
    submitLabel: existing ? t.save : t.sendRequest,
    onSubmit: async (values) => {
      const ready = workspace.isPlatformAdmin && values.n8n_workflow_id;
      await saveSource({
        id: existing?.id, kind: values.kind, name: values.name, ai_description: values.ai_description,
        config: { ...config, mode: values.mode, system: values.system, base_url: values.base_url, details: values.details },
        status: ready ? 'active' : existing?.status === 'active' ? 'active' : 'pending_setup',
        ...(workspace.isPlatformAdmin ? { n8n_workflow_id: values.n8n_workflow_id || null } : {}),
      });
      toast(existing ? t.saved : t.connectorRequested, 'success');
      onSaved();
    },
  });
}
