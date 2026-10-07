import { db, query } from './supabaseClient.js';
import { orgId } from './workspace.js';

export const SOURCE_KINDS = ['excel', 'google_sheet', 'database', 'api'];
export const MAX_IMPORT_ROWS = 20000;

export const listSources = () => query('data_sources', `select=*&org_id=eq.${orgId()}&order=created_at`);

export const previewRecords = (sourceId, limit = 20) => query('org_records', `select=data&source_id=eq.${sourceId}&order=external_key&limit=${limit}`);

export async function saveSource({ id, ...values }) {
  const rows = id
    ? await db.update('data_sources', `id=eq.${id}`, { ...values, updated_at: new Date().toISOString() })
    : await db.insert('data_sources', { org_id: orgId(), ...values });
  return rows[0];
}

export const deleteSource = (id) => db.remove('data_sources', `id=eq.${id}`);

export const replaceRecords = (sourceId, rows, keyColumn) => db.rpc('replace_source_records', { p_source: sourceId, p_rows: rows, p_key_column: keyColumn || null });

export const searchRecords = (text, limit = 8) => db.rpc('search_org_records', { p_org: orgId(), p_query: text, p_limit: limit });

// Google Sheets are re-imported by the n8n "Autexa Sheets Sync" workflow; clearing last_sync_at queues it for the next minute.
export const requestSync = (id) => saveSource({ id, last_sync_at: null, status: 'active', error: null });

let sheetJs = null;
export function loadSheetJs() {
  sheetJs ??= import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs').catch((error) => { sheetJs = null; throw error; });
  return sheetJs;
}

// Reads every sheet of an Excel/CSV file into { name, headers, rows } with string cell values.
export async function readWorkbook(file) {
  const XLSX = await loadSheetJs();
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  return workbook.SheetNames.map((name) => {
    const table = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false });
    const headers = (table[0] || []).map((header, index) => String(header).trim() || `column_${index + 1}`);
    const rows = table.slice(1).filter((cells) => cells.some((cell) => String(cell).trim() !== ''))
      .map((cells) => Object.fromEntries(headers.map((header, index) => [header, String(cells[index] ?? '').trim()])));
    return { name, headers, rows };
  });
}
