import { esc, initials } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { timeAgo } from '../../lib/format.js';
import { emptyRow, loadingRow, openModal, toastError, wireTabs } from '../../lib/ui.js';
import { subscribe } from '../../services/supabaseClient.js';
import { listConversations, sendMessage, startConversation } from '../../services/conversations.js';
import { listCustomers } from '../../services/customers.js';
import { whatsappProvider } from '../../services/integrations.js';
import { getTemplates } from '../../services/templates.js';
import { can, orgId } from '../../services/workspace.js';
import { mountThread } from './Thread.js';

const filters = ['all', 'open', 'mine', 'unassigned', 'paused', 'resolved'];
let activeFilter = 'all';

export function render({ t, id }) {
  return `
    <div class="inbox ${id ? 'has-thread' : ''}">
      <aside class="panel inbox-list">
        <div class="inbox-list-head">
          <div class="inbox-title"><h1>${esc(t.conversations)}</h1>${can('agent') ? `<button class="create small" id="new-conversation">＋</button>` : ''}</div>
          <input type="search" class="search-input" id="conversation-search" placeholder="${esc(t.searchConversations)}" />
          <div class="filter-tabs scroll">${filters.map((filter) => `<button class="filter-tab ${filter === activeFilter ? 'active' : ''}" data-filter="${filter}">${esc(t[`filter_${filter}`])}</button>`).join('')}</div>
          <span class="source" id="conversations-count"></span>
        </div>
        <div class="conversation-list" id="conversation-list">${loadingRow(t.loading)}</div>
      </aside>
      <section class="panel inbox-thread" id="thread">
        ${id ? loadingRow(t.loading) : `<div class="empty-state compact"><div class="empty-orb">◫</div><h2>${esc(t.selectConversation)}</h2><p>${esc(t.selectConversationText)}</p></div>`}
      </section>
    </div>`;
}

function rowHtml(item, t, activeId) {
  const name = item.customers?.full_name || item.customers?.phone || t.customer;
  return `
    <a class="conversation-row ${item.id === activeId ? 'active' : ''}" href="${href('conversations', item.id)}" data-id="${item.id}">
      <div class="conversation-main">
        <i class="customer-avatar">${esc(initials(name))}</i>
        <div class="conversation-meta">
          <strong>${esc(name)}</strong>
          <p class="conversation-preview">${esc(item.last_message_preview || t.noMessages)}</p>
          <div class="row-badges">
            <span class="status ${esc(item.status)}">${esc(t[`status_${item.status}`] || item.status)}</span>
            ${item.ai_paused ? `<span class="tag tag-warn">${esc(t.humanMode)}</span>` : `<span class="ai-badge">AI</span>`}
            ${item.intent ? `<span class="tag tag-light">${esc(item.intent)}</span>` : ''}
          </div>
        </div>
      </div>
      <span class="conversation-time">${esc(timeAgo(item.last_message_at || item.created_at))}</span>
    </a>`;
}

export async function mount(root, ctx) {
  const { t, id } = ctx;
  const list = root.querySelector('#conversation-list');
  const searchInput = root.querySelector('#conversation-search');
  let items = [];

  const renderList = () => {
    const term = searchInput.value.trim().toLowerCase();
    const visible = term ? items.filter((item) => [item.customers?.full_name, item.customers?.phone, item.last_message_preview, item.intent].some((value) => value?.toLowerCase().includes(term))) : items;
    root.querySelector('#conversations-count').textContent = `${visible.length} ${t.conversations.toLowerCase()}`;
    list.innerHTML = visible.length ? visible.map((item) => rowHtml(item, t, id)).join('') : emptyRow(t.noConversations);
  };

  const load = async () => {
    try { items = await listConversations(activeFilter); renderList(); } catch (error) { list.innerHTML = emptyRow(error.message); }
  };

  wireTabs(root, '.filter-tab', (filter) => { activeFilter = filter; load(); });
  searchInput.addEventListener('input', renderList);
  root.querySelector('#new-conversation')?.addEventListener('click', () => create(ctx));

  let reloadTimer = null;
  const unsubscribe = subscribe({ table: 'conversations', filter: `org_id=eq.${orgId()}` }, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 400);
  });

  const threadCleanup = id ? mountThread(root.querySelector('#thread'), ctx, id) : null;
  await load();
  return async () => {
    unsubscribe();
    clearTimeout(reloadTimer);
    (await threadCleanup)?.();
  };
}

export async function create(ctx) {
  const { t } = ctx;
  let customers = [];
  let templates = [];
  let provider = 'meta';
  try {
    provider = await whatsappProvider();
    [customers, templates] = await Promise.all([listCustomers(1000), provider === 'waha' ? [] : getTemplates('approved')]);
  } catch (error) { toastError(error); return; }
  const firstMessage = provider === 'waha'
    ? [{ name: 'text', label: t.message, type: 'textarea', required: true }]
    : [
      { name: 'template_id', label: t.template, type: 'select', required: true, options: [['', t.chooseTemplate], ...templates.map((template) => [template.id, `${template.name} (${template.language})`])], hint: templates.length ? t.templateRequiredHint : t.noApprovedTemplates },
      { name: 'variables', label: t.templateVariables, type: 'tags', placeholder: t.templateVariablesHint, full: true },
    ];
  openModal({
    title: t.newConversation,
    fields: [
      { name: 'customer_id', label: t.existingCustomer, type: 'select', options: [['', t.newContact], ...customers.map((customer) => [customer.id, `${customer.full_name || ''} ${customer.phone || ''}`.trim()])] },
      { name: 'phone', label: t.phone, placeholder: '+9665…', hint: t.phoneHint },
      { name: 'name', label: t.fullName },
      ...firstMessage,
    ],
    submitLabel: t.send,
    onSubmit: async (values) => {
      if (!values.customer_id && !values.phone) throw new Error(t.phoneRequired);
      if (provider === 'waha') {
        const started = await startConversation({ customer_id: values.customer_id || undefined, phone: values.phone, text: values.text }, t.wahaReplyOnly);
        ctx.navigate('conversations', started.conversation_id);
        return;
      }
      const result = await sendMessage({
        customer_id: values.customer_id || undefined,
        phone: values.customer_id ? undefined : values.phone,
        name: values.name || undefined,
        template: { id: values.template_id, variables: values.variables },
      });
      ctx.navigate('conversations', result.conversation_id);
    },
  });
}
