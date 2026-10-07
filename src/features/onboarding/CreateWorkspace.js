import { esc, options } from '../../lib/html.js';
import { createOrganization } from '../../services/workspace.js';

const industries = ['clinic', 'salon', 'restaurant', 'retail', 'ecommerce', 'real_estate', 'education', 'services', 'other'];

export function renderCreateWorkspace(t) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return `
    <div class="auth-screen">
      <form class="auth-card" id="workspace-form">
        <div class="brand auth-brand"><span class="brand-mark">A</span><span>autexa</span></div>
        <p class="eyebrow">${esc(t.stepOf.replace('{n}', 1).replace('{total}', 5))}</p>
        <h1>${esc(t.createWorkspaceTitle)}</h1>
        <p class="muted-text">${esc(t.createWorkspaceText)}</p>
        <label class="form-field"><span>${esc(t.businessName)}</span><input name="name" required /></label>
        <label class="form-field"><span>${esc(t.industry)}</span><select name="industry">${options(industries.map((key) => [key, t[`industry_${key}`] || key]), 'services')}</select></label>
        <label class="form-field"><span>${esc(t.timezone)}</span><input name="timezone" value="${esc(timezone)}" required /></label>
        <label class="form-field"><span>${esc(t.customerLanguage)}</span><select name="locale">${options([['ar', 'العربية'], ['en', 'English']], document.documentElement.lang)}</select></label>
        <p class="form-error" hidden></p>
        <button class="create wide-btn" type="submit">${esc(t.createWorkspace)}</button>
        <div class="auth-links"><button type="button" class="link" id="signout-link">${esc(t.signOut)}</button></div>
      </form>
    </div>`;
}

export function mountCreateWorkspace(root, { onCreated, onSignOut }) {
  const form = root.querySelector('#workspace-form');
  root.querySelector('#signout-link').addEventListener('click', onSignOut);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const errorBox = form.querySelector('.form-error');
    submit.disabled = true;
    try {
      await createOrganization(Object.fromEntries(new FormData(form)));
      onCreated();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      submit.disabled = false;
    }
  });
}
