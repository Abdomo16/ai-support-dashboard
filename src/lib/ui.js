import { esc, options } from './html.js';

let labels = { cancel: 'Cancel', save: 'Save', confirm: 'Confirm' };
export const setUiLabels = (next) => { labels = { ...labels, ...next }; };

export function toast(message, tone = 'info') {
  let element = document.querySelector('#toast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'toast';
    element.className = 'toast';
    element.setAttribute('role', 'status');
    document.body.append(element);
  }
  element.textContent = message;
  element.dataset.tone = tone;
  element.classList.add('visible');
  clearTimeout(element.hideTimer);
  element.hideTimer = setTimeout(() => element.classList.remove('visible'), 3200);
}

export const toastError = (error) => toast(error?.message || String(error), 'error');

export function field(spec) {
  const { name, label, type = 'text', value = '', required, placeholder = '', hint, rows = 4, full, min, max, step, accept, disabled } = spec;
  const common = `name="${esc(name)}" id="field-${esc(name)}" ${required ? 'required' : ''} ${disabled ? 'disabled' : ''} placeholder="${esc(placeholder)}"`;
  let control;
  if (type === 'textarea') control = `<textarea ${common} rows="${rows}">${esc(value)}</textarea>`;
  else if (type === 'select') control = `<select ${common}>${options(spec.options || [], value)}</select>`;
  else if (type === 'checkbox') control = `<label class="switch-row"><input type="checkbox" name="${esc(name)}" ${value ? 'checked' : ''} ${disabled ? 'disabled' : ''} /><span>${esc(label)}</span></label>`;
  else if (type === 'tags') control = `<input type="text" data-type="tags" ${common} value="${esc(Array.isArray(value) ? value.join(', ') : value)}" />`;
  else if (type === 'json') control = `<textarea data-type="json" ${common} rows="${rows}" class="mono">${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</textarea>`;
  else if (type === 'file') control = `<input type="file" ${common} ${accept ? `accept="${esc(accept)}"` : ''} />`;
  else control = `<input type="${esc(type)}" ${common} value="${esc(value)}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} ${step !== undefined ? `step="${step}"` : ''} ${type === 'number' ? 'data-type="number"' : ''} />`;
  if (type === 'checkbox') return `<div class="form-field ${full ? 'full' : ''}">${control}${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  return `<div class="form-field ${full || type === 'textarea' || type === 'json' ? 'full' : ''}"><label for="field-${esc(name)}">${esc(label)}${required ? ' *' : ''}</label>${control}${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
}

export function formValues(form) {
  const values = {};
  form.querySelectorAll('[name]').forEach((input) => {
    if (input.type === 'checkbox') values[input.name] = input.checked;
    else if (input.type === 'file') values[input.name] = input.files?.[0] || null;
    else if (input.dataset.type === 'tags') values[input.name] = input.value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (input.dataset.type === 'number') values[input.name] = input.value === '' ? null : Number(input.value);
    else if (input.dataset.type === 'json') values[input.name] = input.value.trim() ? JSON.parse(input.value) : null;
    else values[input.name] = input.value.trim();
  });
  return values;
}

export function openModal({ title, fields = [], html = '', submitLabel, onSubmit, wide = false, onMount, hideSubmit = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <form class="modal ${wide ? 'wide' : ''}" novalidate>
      <header class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="modal-body"><div class="form-grid">${fields.map(field).join('')}</div>${html}</div>
      <p class="form-error" hidden></p>
      <footer class="modal-foot"><button type="button" class="ghost-btn" data-close>${esc(labels.cancel)}</button>${hideSubmit ? '' : `<button type="submit" class="create">${esc(submitLabel || labels.save)}</button>`}</footer>
    </form>`;
  const form = overlay.querySelector('form');
  const errorBox = overlay.querySelector('.form-error');
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', close));
  document.addEventListener('keydown', onKey);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const submit = form.querySelector('[type="submit"]');
    errorBox.hidden = true;
    submit && (submit.disabled = true);
    try {
      const result = await onSubmit?.(formValues(form), form);
      if (result !== false) close();
    } catch (error) {
      errorBox.textContent = error.message || String(error);
      errorBox.hidden = false;
    } finally {
      submit && (submit.disabled = false);
    }
  });
  document.body.append(overlay);
  onMount?.(form, close);
  form.querySelector('input:not([type=hidden]),textarea,select')?.focus();
  return { close, form };
}

export function confirmDialog(message, { danger = true, confirmLabel } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const { form } = openModal({
      title: labels.confirm,
      html: `<p class="confirm-text">${esc(message)}</p>`,
      submitLabel: confirmLabel || labels.confirm,
      onSubmit: () => { settled = true; resolve(true); },
    });
    if (danger) form.querySelector('[type="submit"]').classList.add('danger');
    const observer = new MutationObserver(() => {
      if (!document.body.contains(form)) { observer.disconnect(); if (!settled) resolve(false); }
    });
    observer.observe(document.body, { childList: true });
  });
}

export function wireTabs(root, selector, onChange) {
  const tabs = root.querySelectorAll(selector);
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((other) => other.classList.toggle('active', other === tab));
    onChange(tab.dataset.tab || tab.dataset.filter);
  }));
}

export const loadingRow = (text) => `<div class="loading-row">${esc(text)}…</div>`;
export const emptyRow = (text) => `<div class="loading-row">${esc(text)}</div>`;
