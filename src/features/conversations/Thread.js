import { esc, initials, options } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDate, formatTime, timeAgo } from '../../lib/format.js';
import { emptyRow, openModal, toast, toastError } from '../../lib/ui.js';
import { subscribe } from '../../services/supabaseClient.js';
import {
  addNote, getConversation, getMessage, getMessages, handBackToAi, isWindowOpen, mediaUrls, replyRuleError, requestInsights,
  sendMessage, setFeedback, takeOver, updateConversation, uploadMedia,
} from '../../services/conversations.js';
import { createHandoff } from '../../services/handoffs.js';
import { whatsappProvider } from '../../services/integrations.js';
import { fillVariables, getCannedResponses } from '../../services/cannedResponses.js';
import { getMembers, memberName } from '../../services/team.js';
import { getTemplates } from '../../services/templates.js';
import { saveArticle } from '../../services/knowledgeBase.js';
import { can, workspace } from '../../services/workspace.js';

const ticks = { queued: '…', sending: '…', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };

function mediaHtml(message, urls, t) {
  const url = message.media_path ? urls[message.media_path] : null;
  const payload = message.payload || {};
  if (message.message_type === 'location' && payload.latitude) {
    return `<a class="media-link" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(`${payload.latitude},${payload.longitude}`)}">⌖ ${esc(payload.name || payload.address || t.location)}</a>`;
  }
  if (!url) return message.media_path ? `<span class="media-link">${esc(t.mediaUnavailable)}</span>` : '';
  if (message.message_type === 'image' || message.message_type === 'sticker') return `<a href="${esc(url)}" target="_blank" rel="noopener"><img class="media-image" src="${esc(url)}" alt="" loading="lazy" /></a>`;
  if (message.message_type === 'audio') return `<audio controls preload="none" src="${esc(url)}"></audio>`;
  if (message.message_type === 'video') return `<video controls preload="none" src="${esc(url)}"></video>`;
  return `<a class="media-link" target="_blank" rel="noopener" href="${esc(url)}">⎙ ${esc(payload.filename || t.document)}</a>`;
}

function messageHtml(message, urls, t) {
  if (message.is_internal_note) {
    return `<div class="note-bubble" data-message="${message.id}"><small>${esc(t.internalNote)} · ${esc(message.agent?.full_name || '')} · ${esc(formatTime(message.sent_at))}</small><p>${esc(message.content)}</p></div>`;
  }
  const inbound = message.direction === 'inbound';
  const author = inbound ? '' : message.is_ai_generated ? '<span class="ai-badge">AI</span>' : `<span class="author">${esc(message.agent?.full_name || (message.sender_type === 'system' ? t.system : t.agent))}</span>`;
  const feedback = !inbound && message.is_ai_generated && can('agent') ? `
    <span class="feedback">
      <button type="button" class="${message.feedback === 1 ? 'on' : ''}" data-feedback="1" data-id="${message.id}" title="${esc(t.goodAnswer)}">▲</button>
      <button type="button" class="${message.feedback === -1 ? 'on bad' : ''}" data-feedback="-1" data-id="${message.id}" title="${esc(t.wrongAnswer)}">▼</button>
      <button type="button" class="link" data-correct="${message.id}">${esc(t.correctAnswer)}</button>
    </span>` : '';
  return `
    <div class="bubble-row ${inbound ? 'in' : 'out'}" data-message="${message.id}">
      <div class="bubble ${message.is_ai_generated ? 'ai' : ''} ${message.delivery_status === 'failed' ? 'failed' : ''}">
        ${mediaHtml(message, urls, t)}
        ${message.content ? `<p>${esc(message.content)}</p>` : ''}
        <small>${author}${esc(formatTime(message.sent_at))}${!inbound && message.delivery_status ? ` <span class="tick ${esc(message.delivery_status)}">${ticks[message.delivery_status] || ''}</span>` : ''}${message.ai_confidence ? ` · ${Math.round(message.ai_confidence * 100)}%` : ''}</small>
      </div>
      ${feedback}
    </div>`;
}

function messagesHtml(messages, urls, t) {
  if (!messages.length) return emptyRow(t.noMessages);
  let lastDay = '';
  return messages.map((message) => {
    const day = formatDate(message.sent_at);
    const separator = day !== lastDay ? `<div class="day-separator"><span>${esc(day)}</span></div>` : '';
    lastDay = day;
    return separator + messageHtml(message, urls, t);
  }).join('');
}

function headerHtml(conversation, members, t) {
  const customer = conversation.customers || {};
  const name = customer.full_name || customer.phone || t.customer;
  const editable = can('agent');
  return `
    <a class="back-link" href="#/conversations">←</a>
    <i class="customer-avatar large">${esc(initials(name))}</i>
    <div class="thread-who">
      <a href="${href('customers', customer.id)}"><strong>${esc(name)}</strong></a>
      <small>${esc(customer.phone || '')}${(customer.tags || []).map((tag) => ` <span class="tag">${esc(tag)}</span>`).join('')}</small>
    </div>
    <div class="thread-actions">
      <span class="status ${esc(conversation.status)}">${esc(t[`status_${conversation.status}`] || conversation.status)}</span>
      ${conversation.ai_paused ? `<span class="tag tag-warn">${esc(t.humanMode)}</span>` : '<span class="ai-badge">AI</span>'}
      ${editable ? `
        <select id="assign-select" class="mini-select" title="${esc(t.assignTo)}">${options([['', t.unassigned], ...members.map((member) => [member.user_id, memberName(member)])], conversation.assigned_to)}</select>
        <button type="button" class="ghost-btn" id="toggle-ai">${esc(conversation.ai_paused ? t.handBackToAi : t.takeOver)}</button>
        <button type="button" class="ghost-btn" id="request-handoff">${esc(t.escalate)}</button>
        <button type="button" class="ghost-btn" id="toggle-status">${esc(conversation.status === 'resolved' ? t.reopen : t.resolve)}</button>` : ''}
    </div>`;
}

function insightsHtml(conversation, t) {
  return `
    <div class="insight-items">
      ${conversation.summary ? `<p><b>${esc(t.summary)}:</b> ${esc(conversation.summary)}</p>` : `<p class="muted-text">${esc(t.noSummary)}</p>`}
      <div class="row-badges">
        ${conversation.intent ? `<span class="tag tag-light">${esc(t.intent)}: ${esc(conversation.intent)}</span>` : ''}
        ${conversation.sentiment ? `<span class="tag sentiment-${esc(conversation.sentiment)}">${esc(t.sentiment)}: ${esc(t[`sentiment_${conversation.sentiment}`] || conversation.sentiment)}</span>` : ''}
        ${conversation.ai_confidence ? `<span class="tag">${esc(t.confidence)}: ${Math.round(conversation.ai_confidence * 100)}%</span>` : ''}
      </div>
    </div>
    ${can('agent') ? `<button type="button" class="link" id="generate-insights">${esc(conversation.summary ? t.refreshSummary : t.generateSummary)}</button>` : ''}`;
}

export async function mountThread(container, ctx, id) {
  const { t } = ctx;
  let conversation;
  let messages;
  let members = [];
  let canned = [];
  let urls = {};
  let provider = 'meta';
  try {
    [conversation, messages, members, canned, provider] = await Promise.all([getConversation(id), getMessages(id), getMembers().catch(() => []), getCannedResponses().catch(() => []), whatsappProvider()]);
  } catch (error) {
    container.innerHTML = emptyRow(error.message);
    return null;
  }
  if (!conversation) { container.innerHTML = emptyRow(t.notFound); return null; }
  urls = await mediaUrls(messages).catch(() => ({}));

  container.innerHTML = `
    <header class="thread-head" id="thread-head"></header>
    <div class="thread-insights" id="thread-insights"></div>
    <div class="thread-messages" id="thread-messages"></div>
    ${can('agent') ? `
    <form class="composer" id="composer">
      <div class="composer-tabs"><button type="button" class="active" data-mode="reply">${esc(t.reply)}</button><button type="button" data-mode="note">${esc(t.internalNote)}</button></div>
      <div class="window-warning" id="window-warning" hidden>${esc(provider === 'waha' ? t.wahaRule_never_messaged : t.windowClosed)}</div>
      <div class="canned-menu" id="canned-menu" hidden></div>
      <textarea id="composer-input" rows="3" placeholder="${esc(t.composerPlaceholder)}"></textarea>
      <div class="composer-actions">
        <label class="icon-btn attach" title="${esc(t.attach)}" ${provider === 'waha' ? 'hidden' : ''}>⎘<input type="file" id="composer-file" hidden accept="image/*,audio/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx" /></label>
        <button type="button" class="ghost-btn" id="canned-button">${esc(t.quickReplies)}</button>
        <button type="button" class="ghost-btn" id="template-button" ${provider === 'waha' ? 'hidden' : ''}>${esc(t.sendTemplate)}</button>
        <span class="attachment-name" id="attachment-name"></span>
        <button type="submit" class="create">${esc(t.send)}</button>
      </div>
    </form>` : ''}`;

  const head = container.querySelector('#thread-head');
  const insights = container.querySelector('#thread-insights');
  const list = container.querySelector('#thread-messages');
  const composer = container.querySelector('#composer');
  let mode = 'reply';

  const scrollToEnd = () => { list.scrollTop = list.scrollHeight; };
  const renderMessages = () => { list.innerHTML = messagesHtml(messages, urls, t); scrollToEnd(); };
  const renderHeader = () => {
    head.innerHTML = headerHtml(conversation, members, t);
    insights.innerHTML = insightsHtml(conversation, t);
    const warning = container.querySelector('#window-warning');
    if (warning) warning.hidden = mode === 'note' || isWindowOpen(conversation, provider);
    wireHeader();
  };

  const patchConversation = async (patch) => {
    try { const [row] = await patch; if (row) { conversation = { ...conversation, ...row }; renderHeader(); } } catch (error) { toastError(error); }
  };

  function wireHeader() {
    head.querySelector('#assign-select')?.addEventListener('change', (event) => patchConversation(updateConversation(id, { assigned_to: event.target.value || null })));
    head.querySelector('#toggle-ai')?.addEventListener('click', () => patchConversation(conversation.ai_paused ? handBackToAi(id) : takeOver(id)));
    head.querySelector('#toggle-status')?.addEventListener('click', () => patchConversation(updateConversation(id, { status: conversation.status === 'resolved' ? 'open' : 'resolved' })));
    head.querySelector('#request-handoff')?.addEventListener('click', () => openModal({
      title: t.escalate,
      fields: [{ name: 'reason', label: t.reason, required: true, full: true }],
      onSubmit: async ({ reason }) => { await createHandoff(id, reason); await patchConversation(updateConversation(id, { ai_paused: true })); toast(t.handoffCreated, 'success'); },
    }));
    insights.querySelector('#generate-insights')?.addEventListener('click', async (event) => {
      event.target.disabled = true;
      try { const result = await requestInsights(id); conversation = { ...conversation, ...result }; renderHeader(); } catch (error) { toastError(error); event.target.disabled = false; }
    });
  }

  const upsertMessage = async (message) => {
    const index = messages.findIndex((item) => item.id === message.id);
    if (message.media_path && !urls[message.media_path]) urls = { ...urls, ...(await mediaUrls([message]).catch(() => ({}))) };
    if (index >= 0) messages[index] = { ...messages[index], ...message };
    else messages.push(message);
    messages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
    renderMessages();
  };

  list.addEventListener('click', async (event) => {
    const feedbackButton = event.target.closest('[data-feedback]');
    if (feedbackButton) {
      const message = messages.find((item) => item.id === feedbackButton.dataset.id);
      const value = Number(feedbackButton.dataset.feedback);
      try { await setFeedback(message.id, message.feedback === value ? null : value); await upsertMessage({ ...message, feedback: message.feedback === value ? null : value }); } catch (error) { toastError(error); }
      return;
    }
    const correctButton = event.target.closest('[data-correct]');
    if (correctButton) openCorrection(messages.find((item) => item.id === correctButton.dataset.correct));
  });

  function openCorrection(message) {
    const index = messages.indexOf(message);
    const question = [...messages.slice(0, index)].reverse().find((item) => item.direction === 'inbound')?.content || '';
    openModal({
      title: t.correctAnswer,
      html: `<p class="muted-text">${esc(t.correctAnswerHelp)}</p><blockquote class="quote">${esc(message.content)}</blockquote>`,
      fields: [
        { name: 'question', label: t.question, value: question, required: true, full: true },
        { name: 'answer', label: t.correctAnswerLabel, type: 'textarea', required: true },
      ],
      submitLabel: t.saveToKnowledge,
      onSubmit: async ({ question: q, answer }) => {
        await setFeedback(message.id, -1, answer);
        await saveArticle({ question: q, answer, category: t.corrections, keywords: [], is_active: true, source: 'correction' });
        await upsertMessage({ ...message, feedback: -1 });
        toast(t.correctionSaved, 'success');
      },
    });
  }

  const unsubscribeMessages = subscribe({ table: 'messages', filter: `conversation_id=eq.${id}` }, async (change) => {
    if (change.type === 'DELETE') return;
    const full = change.type === 'INSERT' && change.record.sent_by ? await getMessage(change.record.id).catch(() => change.record) : change.record;
    upsertMessage(full);
  });
  const unsubscribeConversation = subscribe({ table: 'conversations', filter: `id=eq.${id}` }, (change) => {
    if (change.type !== 'UPDATE') return;
    conversation = { ...conversation, ...change.record, customers: conversation.customers };
    renderHeader();
  });

  renderHeader();
  renderMessages();
  if (composer) wireComposer();

  function wireComposer() {
    const input = composer.querySelector('#composer-input');
    const fileInput = composer.querySelector('#composer-file');
    const cannedMenu = composer.querySelector('#canned-menu');
    const attachmentName = composer.querySelector('#attachment-name');

    composer.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
      mode = button.dataset.mode;
      composer.querySelectorAll('[data-mode]').forEach((other) => other.classList.toggle('active', other === button));
      composer.classList.toggle('note-mode', mode === 'note');
      composer.querySelector('#window-warning').hidden = mode === 'note' || isWindowOpen(conversation, provider);
      input.placeholder = mode === 'note' ? t.notePlaceholder : t.composerPlaceholder;
    }));

    const showCanned = (term = '') => {
      const matches = canned.filter((item) => `${item.shortcut} ${item.title}`.toLowerCase().includes(term.toLowerCase())).slice(0, 8);
      cannedMenu.innerHTML = matches.length ? matches.map((item) => `<button type="button" class="dropdown-item" data-canned="${item.id}"><span><strong>/${esc(item.shortcut)}</strong> ${esc(item.title)}</span><small>${esc(item.body.slice(0, 80))}</small></button>`).join('') : `<div class="dropdown-empty">${esc(t.noQuickReplies)} <a class="link" href="#/settings/canned">${esc(t.manage)}</a></div>`;
      cannedMenu.hidden = false;
    };
    cannedMenu.addEventListener('click', (event) => {
      const item = canned.find((entry) => entry.id === event.target.closest('[data-canned]')?.dataset.canned);
      if (!item) return;
      input.value = fillVariables(item.body, { customer: conversation.customers });
      cannedMenu.hidden = true;
      input.focus();
    });
    composer.querySelector('#canned-button').addEventListener('click', () => (cannedMenu.hidden ? showCanned() : (cannedMenu.hidden = true)));
    input.addEventListener('input', () => {
      const match = input.value.match(/^\/(\S*)$/);
      if (match) showCanned(match[1]); else cannedMenu.hidden = true;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); composer.requestSubmit(); }
    });
    fileInput.addEventListener('change', () => { attachmentName.textContent = fileInput.files[0]?.name || ''; });
    composer.querySelector('#template-button').addEventListener('click', openTemplatePicker);

    composer.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      const file = fileInput.files[0];
      if (!text && !file) return;
      const submit = composer.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        if (mode === 'note') {
          const [note] = await addNote(id, text);
          await upsertMessage({ ...note, agent: { full_name: workspace.profile?.full_name } });
        } else {
          if (!isWindowOpen(conversation, provider)) throw new Error(provider === 'waha' ? t.wahaRule_never_messaged : t.windowClosed);
          const mediaPath = file ? await uploadMedia(id, file) : undefined;
          const result = await sendMessage({ conversation_id: id, text, media_path: mediaPath, media_mime: file?.type });
          if (result?.message) await upsertMessage({ ...result.message, agent: { full_name: workspace.profile?.full_name } });
          if (!conversation.ai_paused) { conversation.ai_paused = true; renderHeader(); }
        }
        input.value = '';
        fileInput.value = '';
        attachmentName.textContent = '';
      } catch (error) {
        toastError(replyRuleError(error, t));
      } finally {
        submit.disabled = false;
      }
    });
  }

  async function openTemplatePicker() {
    let templates = [];
    try { templates = await getTemplates('approved'); } catch (error) { toastError(error); return; }
    openModal({
      title: t.sendTemplate,
      fields: [
        { name: 'template_id', label: t.template, type: 'select', required: true, options: [['', t.chooseTemplate], ...templates.map((template) => [template.id, `${template.name} (${template.language})`])], hint: templates.length ? '' : t.noApprovedTemplates },
        { name: 'variables', label: t.templateVariables, type: 'tags', placeholder: t.templateVariablesHint, full: true },
      ],
      submitLabel: t.send,
      onSubmit: async (values) => {
        const result = await sendMessage({ conversation_id: id, template: { id: values.template_id, variables: values.variables } });
        if (result?.message) await upsertMessage(result.message);
      },
    });
  }

  const ticker = setInterval(() => {
    const warning = container.querySelector('#window-warning');
    if (warning) warning.hidden = mode === 'note' || isWindowOpen(conversation, provider);
    head.querySelectorAll('[data-ago]').forEach((element) => { element.textContent = timeAgo(element.dataset.ago); });
  }, 60000);

  return () => { unsubscribeMessages(); unsubscribeConversation(); clearInterval(ticker); };
}
