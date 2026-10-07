import { esc } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDuration, formatMoney, formatNumber, timeAgo } from '../../lib/format.js';
import { barList } from '../../lib/charts.js';
import { emptyRow, field, formValues, loadingRow, toast, toastError } from '../../lib/ui.js';
import { getAiEvents, getAiReplies, getAiSettings, runPlayground, saveAiSettings } from '../../services/aiSettings.js';
import { getAiHealth } from '../../services/analytics.js';
import { can } from '../../services/workspace.js';
import { healthPanel } from '../dashboard/Overview.js';

const tabs = ['settings', 'rules', 'playground', 'quality'];
const tones = ['friendly', 'professional', 'concise', 'warm', 'playful'];
const dialects = ['auto', 'gulf', 'egyptian', 'levantine', 'maghrebi', 'msa'];
const models = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];
const toolKeys = ['bookings', 'orders', 'payments', 'handoff'];
let playgroundHistory = [];

export function render({ t, id }) {
  const tab = tabs.includes(id) ? id : 'settings';
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.aiControlCenter)}</p><h1>${esc(t.aiAgent)}</h1><p>${esc(t.aiAgentSubtitle)}</p></div>
      <div class="heading-actions" id="live-toggle"></div>
    </div>
    <div class="page-tabs">${tabs.map((key) => `<a class="page-tab ${key === tab ? 'active' : ''}" href="${href('ai', key === 'settings' ? null : key)}">${esc(t[`aiTab_${key}`])}</a>`).join('')}</div>
    <div id="ai-body">${loadingRow(t.loading)}</div>`;
}

export async function mount(root, ctx) {
  const { t, id } = ctx;
  const tab = tabs.includes(id) ? id : 'settings';
  const body = root.querySelector('#ai-body');
  let settings;
  try { settings = await getAiSettings(); } catch (error) { body.innerHTML = emptyRow(error.message); return; }
  settings ||= {};
  renderLiveToggle(root, ctx, settings);
  if (tab === 'settings') mountSettings(body, ctx, settings);
  if (tab === 'rules') mountRules(body, ctx, settings);
  if (tab === 'playground') mountPlayground(body, ctx, settings);
  if (tab === 'quality') await mountQuality(body, ctx, settings);
}

function renderLiveToggle(root, { t }, settings) {
  const container = root.querySelector('#live-toggle');
  container.innerHTML = `<span class="status ${settings.is_live ? 'resolved' : 'scheduled'}">${esc(settings.is_live ? t.aiLive : t.aiOff)}</span>${can('admin') ? `<button class="${settings.is_live ? 'ghost-btn' : 'create'}" id="toggle-live">${esc(settings.is_live ? t.pauseAi : t.goLive)}</button>` : ''}`;
  container.querySelector('#toggle-live')?.addEventListener('click', async () => {
    try {
      const [saved] = await saveAiSettings({ is_live: !settings.is_live });
      Object.assign(settings, saved);
      renderLiveToggle(root, { t }, settings);
      toast(settings.is_live ? t.aiNowLive : t.aiPaused, 'success');
    } catch (error) { toastError(error); }
  });
}

function settingsForm(body, ctx, fields, onSave, extraHtml = '') {
  const { t } = ctx;
  const readOnly = !can('admin');
  body.innerHTML = `<form class="panel settings-form" id="ai-form">${extraHtml}<div class="form-grid">${fields.map((spec) => field({ ...spec, disabled: readOnly })).join('')}</div>${readOnly ? '' : `<div class="form-actions"><button class="create" type="submit">${esc(t.save)}</button></div>`}</form>`;
  const form = body.querySelector('#ai-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await saveAiSettings(onSave(formValues(form), form)); toast(t.saved, 'success'); } catch (error) { toastError(error); }
  });
  return form;
}

function mountSettings(body, ctx, settings) {
  const { t } = ctx;
  const toolsHtml = `<div class="field-group"><strong>${esc(t.aiTools)}</strong><small>${esc(t.aiToolsHint)}</small><div class="check-row">${toolKeys.map((tool) => `<label class="switch-row"><input type="checkbox" data-tool="${tool}" ${(settings.tools_enabled || []).includes(tool) ? 'checked' : ''} ${can('admin') ? '' : 'disabled'} /><span>${esc(t[`tool_${tool}`])}</span></label>`).join('')}</div></div>`;
  settingsForm(body, ctx, [
    { name: 'persona_name', label: t.personaName, value: settings.persona_name, required: true },
    { name: 'tone', label: t.tone, type: 'select', value: settings.tone, options: tones.map((tone) => [tone, t[`tone_${tone}`] || tone]) },
    { name: 'languages', label: t.languages, type: 'tags', value: settings.languages || ['ar', 'en'], hint: t.languagesHint },
    { name: 'dialect', label: t.arabicDialect, type: 'select', value: settings.dialect, options: dialects.map((dialect) => [dialect, t[`dialect_${dialect}`] || dialect]) },
    { name: 'model', label: t.aiModel, type: 'select', value: settings.model, options: models.map((model) => [model, model]) },
    { name: 'temperature', label: t.creativity, type: 'number', min: 0, max: 1, step: 0.1, value: settings.temperature ?? 0.3 },
    { name: 'system_prompt', label: t.systemPrompt, type: 'textarea', rows: 7, value: settings.system_prompt, placeholder: t.systemPromptPlaceholder },
    { name: 'fallback_message', label: t.fallbackMessage, type: 'textarea', rows: 2, value: settings.fallback_message, hint: t.fallbackHint },
    { name: 'blocked_topics', label: t.blockedTopics, type: 'tags', value: settings.blocked_topics || [], placeholder: t.blockedTopicsPlaceholder, full: true },
    { name: 'after_hours_mode', label: t.afterHoursMode, type: 'select', value: settings.after_hours_mode, options: ['ai_continues', 'away_message', 'handoff'].map((mode) => [mode, t[`afterHours_${mode}`]]), hint: t.businessHoursHint },
    { name: 'after_hours_message', label: t.afterHoursMessage, type: 'textarea', rows: 2, value: settings.after_hours_message },
    { name: 'csat_enabled', label: t.csatEnabled, type: 'checkbox', value: settings.csat_enabled !== false, hint: t.csatEnabledHint },
  ], (values, form) => ({ ...values, tools_enabled: [...form.querySelectorAll('[data-tool]:checked')].map((input) => input.dataset.tool) }), toolsHtml);
}

function mountRules(body, ctx, settings) {
  const { t } = ctx;
  settingsForm(body, ctx, [
    { name: 'handoff_on_human_request', label: t.ruleHumanRequest, type: 'checkbox', value: settings.handoff_on_human_request !== false, full: true },
    { name: 'handoff_keywords', label: t.handoffKeywords, type: 'tags', value: settings.handoff_keywords || [], full: true, hint: t.handoffKeywordsHint },
    { name: 'handoff_on_negative_sentiment', label: t.ruleNegative, type: 'checkbox', value: settings.handoff_on_negative_sentiment !== false, full: true },
    { name: 'handoff_on_low_confidence', label: t.ruleLowConfidence, type: 'checkbox', value: settings.handoff_on_low_confidence !== false, full: true },
    { name: 'confidence_threshold', label: t.confidenceThreshold, type: 'number', min: 0, max: 1, step: 0.05, value: settings.confidence_threshold ?? 0.55, hint: t.confidenceThresholdHint },
    { name: 'vip_tags', label: t.vipTags, type: 'tags', value: settings.vip_tags || ['vip'], hint: t.vipTagsHint },
    { name: 'sla_minutes', label: t.slaMinutes, type: 'number', min: 1, value: settings.sla_minutes ?? 15, hint: t.slaMinutesHint },
  ], (values) => values);
}

function mountPlayground(body, ctx, settings) {
  const { t } = ctx;
  body.innerHTML = `
    <div class="dashboard-grid">
      <article class="panel playground">
        <div class="panel-head"><div><h2>${esc(t.testChat)}</h2><p>${esc(t.playgroundHelp)}</p></div><button class="ghost-btn" id="reset-chat">${esc(t.resetChat)}</button></div>
        <div class="thread-messages playground-messages" id="playground-messages"></div>
        <form class="composer" id="playground-form"><textarea id="playground-input" rows="2" placeholder="${esc(t.playgroundPlaceholder)}" required></textarea><div class="composer-actions"><span class="source">${esc(settings.persona_name || 'Nova')} · ${esc(settings.model || '')}</span><button class="create" type="submit">${esc(t.send)}</button></div></form>
      </article>
      <article class="panel"><div class="panel-head"><h2>${esc(t.debugPanel)}</h2></div><div id="playground-debug" class="debug-panel"><p class="muted-text">${esc(t.debugEmpty)}</p></div></article>
    </div>`;
  const list = body.querySelector('#playground-messages');
  const debug = body.querySelector('#playground-debug');
  const input = body.querySelector('#playground-input');
  const renderChat = () => {
    list.innerHTML = playgroundHistory.length ? playgroundHistory.map((message) => `
      <div class="bubble-row ${message.role === 'user' ? 'in' : 'out'}"><div class="bubble ${message.role === 'assistant' ? 'ai' : ''}"><p>${esc(message.content)}</p>${message.meta ? `<small><span class="ai-badge">AI</span>${Math.round(message.meta.confidence * 100)}%${message.meta.needsHuman ? ` · ${esc(t.wouldHandoff)}` : ''}</small>` : ''}</div></div>`).join('') : emptyRow(t.playgroundEmpty);
    list.scrollTop = list.scrollHeight;
  };
  renderChat();
  body.querySelector('#reset-chat').addEventListener('click', () => { playgroundHistory = []; renderChat(); debug.innerHTML = `<p class="muted-text">${esc(t.debugEmpty)}</p>`; });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); body.querySelector('#playground-form').requestSubmit(); } });
  body.querySelector('#playground-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    playgroundHistory.push({ role: 'user', content: text });
    renderChat();
    list.insertAdjacentHTML('beforeend', `<div class="typing">${esc(t.typing)}…</div>`);
    try {
      const result = await runPlayground(playgroundHistory.map(({ role, content }) => ({ role, content })));
      playgroundHistory.push({ role: 'assistant', content: result.reply || t.noReply, meta: result });
      localStorage.setItem('autexa-playground-tested', '1');
      debug.innerHTML = `
        <dl class="details">
          <dt>${esc(t.confidence)}</dt><dd>${Math.round(result.confidence * 100)}%</dd>
          <dt>${esc(t.intent)}</dt><dd>${esc(result.intent || '—')}</dd>
          <dt>${esc(t.sentiment)}</dt><dd>${esc(result.sentiment || '—')}</dd>
          <dt>${esc(t.wouldHandoff)}</dt><dd>${esc(result.needsHuman || result.confidence < (settings.confidence_threshold ?? 0.55) ? `${t.yes} — ${result.handoffReason || t.lowConfidence}` : t.no)}</dd>
          <dt>${esc(t.latency)}</dt><dd>${esc(formatNumber(result.latency_ms))} ms</dd>
          <dt>${esc(t.tokens)}</dt><dd>${esc(formatNumber(result.usage.tokensIn + result.usage.tokensOut))} (${esc(formatMoney(result.usage.cost, 'USD'))})</dd>
        </dl>
        ${result.unanswered ? `<p class="banner warning">${esc(t.unansweredDetected)}: ${esc(result.unanswered)}</p>` : ''}
        <h3>${esc(t.knowledgeUsed)}</h3>${result.sources.length ? `<ol class="sources">${result.sources.map((source) => `<li>${esc(source)}…</li>`).join('')}</ol>` : `<p class="muted-text">${esc(t.noKnowledgeUsed)}</p>`}
        ${result.actions.length ? `<h3>${esc(t.toolCalls)}</h3>${result.actions.map((action) => `<pre class="mono">${esc(action.tool)}: ${esc(JSON.stringify(action.result, null, 1).slice(0, 600))}</pre>`).join('')}` : ''}`;
    } catch (error) {
      playgroundHistory.pop();
      toastError(error);
    }
    renderChat();
  });
}

async function mountQuality(body, ctx, settings) {
  const { t } = ctx;
  body.innerHTML = `
    <div id="quality-health" class="panel">${loadingRow(t.loading)}</div>
    <div class="metric-grid compact-grid" id="quality-metrics"></div>
    <div class="dashboard-grid">
      <article class="panel table-panel">
        <div class="table-toolbar"><div class="filter-tabs">${['low', 'bad', 'good', 'all'].map((filter, index) => `<button class="filter-tab ${index === 0 ? 'active' : ''}" data-filter="${filter}">${esc(t[`quality_${filter}`])}</button>`).join('')}</div></div>
        <div class="simple-list" id="quality-list">${loadingRow(t.loading)}</div>
      </article>
      <article class="panel"><div class="panel-head"><h2>${esc(t.aiEvents24h)}</h2></div><div id="event-breakdown">${loadingRow(t.loading)}</div></article>
    </div>`;
  const threshold = Number(settings.confidence_threshold ?? 0.55);
  const list = body.querySelector('#quality-list');
  const loadList = async (filter) => {
    list.innerHTML = loadingRow(t.loading);
    try {
      const rows = await getAiReplies(filter === 'low' ? { lowConfidence: threshold } : filter === 'all' ? {} : { feedback: filter });
      list.innerHTML = rows.length ? rows.map((row) => `
        <a class="list-row" href="${href('conversations', row.conversation_id)}">
          <div><strong>${esc(row.content?.slice(0, 160) || '')}</strong><small>${esc(timeAgo(row.sent_at))}${row.feedback_note ? ` · ${esc(t.correction)}: ${esc(row.feedback_note.slice(0, 120))}` : ''}</small></div>
          <span class="tag ${row.ai_confidence !== null && row.ai_confidence < threshold ? 'tag-inactive' : 'tag-light'}">${row.ai_confidence !== null ? `${Math.round(row.ai_confidence * 100)}%` : '—'}${row.feedback === 1 ? ' ▲' : row.feedback === -1 ? ' ▼' : ''}</span>
        </a>`).join('') : emptyRow(t.noAiReplies);
    } catch (error) { list.innerHTML = emptyRow(error.message); }
  };
  body.querySelectorAll('.filter-tab').forEach((tab) => tab.addEventListener('click', () => {
    body.querySelectorAll('.filter-tab').forEach((other) => other.classList.toggle('active', other === tab));
    loadList(tab.dataset.filter);
  }));
  loadList('low');
  try {
    const [health, events, allReplies] = await Promise.all([getAiHealth(), getAiEvents(24), getAiReplies({})]);
    body.querySelector('#quality-health').innerHTML = healthPanel(t, health);
    const rated = allReplies.filter((row) => row.feedback);
    const positive = rated.filter((row) => row.feedback === 1).length;
    const avgConfidence = allReplies.filter((row) => row.ai_confidence !== null).reduce((sum, row, _, all) => sum + row.ai_confidence / all.length, 0);
    const latencies = events.filter((event) => event.kind === 'ai_reply' && event.latency_ms).map((event) => event.latency_ms);
    body.querySelector('#quality-metrics').innerHTML = [
      [t.avgConfidence, allReplies.length ? `${Math.round(avgConfidence * 100)}%` : '—'],
      [t.positiveFeedback, rated.length ? `${Math.round((positive / rated.length) * 100)}%` : '—'],
      [t.p95Latency, latencies.length ? formatDuration(latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] / 1000) : '—'],
      [t.aiCost24h, formatMoney(events.reduce((sum, event) => sum + Number(event.cost_usd || 0), 0), 'USD')],
    ].map(([label, value]) => `<article class="metric-card"><strong>${esc(value)}</strong><p>${esc(label)}</p></article>`).join('');
    const kinds = Object.entries(events.reduce((acc, event) => ({ ...acc, [event.kind]: (acc[event.kind] || 0) + 1 }), {}));
    const errors = events.filter((event) => event.error).slice(0, 8);
    body.querySelector('#event-breakdown').innerHTML = `${kinds.length ? barList(kinds.map(([kind, value]) => ({ label: t[`event_${kind}`] || kind, value }))) : emptyRow(t.noEvents)}
      ${errors.length ? `<h3>${esc(t.recentErrors)}</h3>${errors.map((event) => `<div class="list-row"><div><strong class="danger-text">${esc(event.error)}</strong><small>${esc(t[`event_${event.kind}`] || event.kind)} · ${esc(timeAgo(event.created_at))}</small></div></div>`).join('')}` : ''}`;
  } catch (error) { body.querySelector('#quality-health').innerHTML = emptyRow(error.message); }
}