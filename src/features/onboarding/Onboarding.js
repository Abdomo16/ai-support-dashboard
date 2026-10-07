import { esc } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { loadingRow, toast, toastError } from '../../lib/ui.js';
import { db, query } from '../../services/supabaseClient.js';
import { can, orgId, refreshOrganization, workspace } from '../../services/workspace.js';
import { getAiSettings, saveAiSettings } from '../../services/aiSettings.js';

async function progress() {
  const id = orgId();
  const [accounts, articles, documents, playground, settings] = await Promise.all([
    query('whatsapp_accounts', `select=id&org_id=eq.${id}&status=eq.connected&limit=1`),
    query('knowledge_base_articles', `select=id&org_id=eq.${id}&limit=1`),
    query('kb_documents', `select=id&org_id=eq.${id}&status=eq.ready&limit=1`),
    query('ai_events', `select=id&org_id=eq.${id}&kind=eq.playground&limit=1`),
    getAiSettings(),
  ]);
  return {
    whatsapp: accounts.length > 0,
    knowledge: articles.length + documents.length > 0,
    persona: Boolean(settings?.system_prompt?.trim()) || Object.keys(workspace.org.business_hours || {}).length > 0,
    playground: playground.length > 0,
    live: Boolean(settings?.is_live),
  };
}

const STEPS = [
  { key: 'whatsapp', route: ['integrations'] },
  { key: 'knowledge', route: ['knowledge'] },
  { key: 'persona', route: ['ai'] },
  { key: 'playground', route: ['ai', 'playground'] },
  { key: 'live', route: null },
];

export function render({ t }) {
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.gettingStarted)}</p><h1>${esc(t.onboardingTitle.replace('{name}', workspace.org?.brand_name || workspace.org?.name || ''))}</h1><p>${esc(t.onboardingSubtitle)}</p></div>
    </div>
    <div class="onboarding-progress"><div class="bar-track"><i id="onboarding-bar" style="width:0%"></i></div><span id="onboarding-count"></span></div>
    <ol class="onboarding-steps" id="steps">${loadingRow(t.loading)}</ol>
    <div class="form-actions" id="onboarding-actions"></div>`;
}

export async function mount(root, ctx) {
  const { t } = ctx;
  let done;
  try { done = await progress(); } catch (error) { root.querySelector('#steps').innerHTML = `<li>${esc(error.message)}</li>`; return; }
  const completed = STEPS.filter((step) => done[step.key]).length;
  root.querySelector('#onboarding-bar').style.width = `${(completed / STEPS.length) * 100}%`;
  root.querySelector('#onboarding-count').textContent = t.stepsDone.replace('{done}', completed).replace('{total}', STEPS.length);
  const firstOpen = STEPS.find((step) => !done[step.key])?.key;
  root.querySelector('#steps').innerHTML = STEPS.map((step, index) => `
    <li class="onboarding-step ${done[step.key] ? 'done' : ''} ${step.key === firstOpen ? 'current' : ''}">
      <span class="step-number">${done[step.key] ? '✓' : index + 1}</span>
      <div><strong>${esc(t[`onboard_${step.key}`])}</strong><p>${esc(t[`onboard_${step.key}_desc`])}</p></div>
      ${step.key === 'live'
    ? (can('admin') && !done.live ? `<button class="create" id="go-live" ${done.whatsapp && done.knowledge ? '' : 'disabled'}>${esc(t.goLive)}</button>` : '')
    : `<a class="${done[step.key] ? 'ghost-btn' : 'create'}" href="${href(...step.route)}">${esc(done[step.key] ? t.review : t.start)}</a>`}
    </li>`).join('');
  root.querySelector('#go-live')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { await saveAiSettings({ is_live: true }); toast(t.aiNowLive, 'success'); ctx.refresh(); } catch (error) { toastError(error); event.target.disabled = false; }
  });
  if (!can('admin')) return;
  const allDone = completed === STEPS.length;
  root.querySelector('#onboarding-actions').innerHTML = `<button class="${allDone ? 'create' : 'ghost-btn'}" id="finish-onboarding">${esc(allDone ? t.finishOnboarding : t.skipOnboarding)}</button>`;
  root.querySelector('#finish-onboarding').addEventListener('click', async () => {
    try {
      await db.update('organizations', `id=eq.${orgId()}`, { onboarding_completed: true, onboarding_step: 'done' });
      await refreshOrganization();
      ctx.navigate('overview');
    } catch (error) { toastError(error); }
  });
}
