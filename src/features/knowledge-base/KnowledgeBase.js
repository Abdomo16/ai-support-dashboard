import { esc } from '../../lib/html.js';
import { href } from '../../lib/router.js';
import { formatDateTime, timeAgo } from '../../lib/format.js';
import { confirmDialog, emptyRow, loadingRow, openModal, toast, toastError } from '../../lib/ui.js';
import {
  addDocument, deleteArticle, deleteDocument, ingestDocument, listArticles, listDocuments, listUnanswered, saveArticle, setUnansweredStatus,
} from '../../services/knowledgeBase.js';
import { can } from '../../services/workspace.js';

const tabs = ['articles', 'documents', 'unanswered'];

export function render({ t, id }) {
  const tab = tabs.includes(id) ? id : 'articles';
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${esc(t.aiAnswersEyebrow)}</p><h1>${esc(t.knowledge)}</h1><p>${esc(t.knowledgeSubtitle)}</p></div>
      ${can('agent') ? `<div class="heading-actions"><button class="ghost-btn" id="add-source">＋ ${esc(t.addSource)}</button><button class="create" id="new-article">＋ ${esc(t.newArticle)}</button></div>` : ''}
    </div>
    <div class="page-tabs">${tabs.map((key) => `<a class="page-tab ${key === tab ? 'active' : ''}" href="${href('knowledge', key === 'articles' ? null : key)}">${esc(t[`kbTab_${key}`])}<b class="tab-count" id="count-${key}"></b></a>`).join('')}</div>
    <div id="kb-body">${loadingRow(t.loading)}</div>`;
}

export function openArticleForm(t, article = {}, onSaved) {
  openModal({
    title: article.id ? t.editArticle : t.newArticle,
    wide: true,
    fields: [
      { name: 'question', label: t.question, required: true, value: article.question, full: true },
      { name: 'answer', label: t.answer, type: 'textarea', required: true, value: article.answer, rows: 7 },
      { name: 'category', label: t.category, value: article.category },
      { name: 'keywords', label: t.keywords, type: 'tags', value: article.keywords || [] },
      { name: 'is_active', label: t.activeForAi, type: 'checkbox', value: article.is_active !== false },
    ],
    onMount: (form, close) => {
      if (!article.id || !can('admin')) return;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost-btn danger-text';
      remove.textContent = t.delete;
      remove.addEventListener('click', async () => {
        if (!await confirmDialog(t.deleteConfirm)) return;
        try { await deleteArticle(article.id); close(); onSaved?.(); } catch (error) { toastError(error); }
      });
      form.querySelector('.modal-foot').prepend(remove);
    },
    onSubmit: async (values) => {
      const saved = await saveArticle({ id: article.id, ...values });
      toast(t.saved, 'success');
      onSaved?.(saved);
    },
  });
}

function openSourceForm(t, onAdded) {
  openModal({
    title: t.addSource,
    html: `<p class="muted-text">${esc(t.addSourceHelp)}</p>`,
    fields: [
      { name: 'title', label: t.title },
      { name: 'file', label: t.uploadFile, type: 'file', accept: '.pdf,.txt,.md,.csv,.html,.json', hint: t.uploadFileHint, full: true },
      { name: 'url', label: t.websiteUrl, type: 'url', placeholder: 'https://example.com/faq', full: true },
      { name: 'text', label: t.pasteText, type: 'textarea', rows: 5 },
    ],
    submitLabel: t.addAndIndex,
    onSubmit: async (values) => {
      if (!values.file && !values.url && !values.text) throw new Error(t.sourceRequired);
      await addDocument(values);
      toast(t.sourceAdded, 'success');
      onAdded?.();
    },
  });
}

export async function mount(root, ctx) {
  const { t, id } = ctx;
  const tab = tabs.includes(id) ? id : 'articles';
  const body = root.querySelector('#kb-body');
  root.querySelector('#new-article')?.addEventListener('click', () => create(ctx));
  root.querySelector('#add-source')?.addEventListener('click', () => openSourceForm(t, () => ctx.navigate('knowledge', 'documents')));
  listUnanswered().then((rows) => { root.querySelector('#count-unanswered').textContent = rows.length || ''; }).catch(() => {});

  if (tab === 'articles') await mountArticles(body, ctx);
  if (tab === 'documents') return mountDocuments(body, ctx);
  if (tab === 'unanswered') await mountUnanswered(body, ctx);
  return undefined;
}

async function mountArticles(body, ctx) {
  const { t } = ctx;
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="table-toolbar"><input type="search" class="search-input" id="knowledge-search" placeholder="${esc(t.searchArticles)}" /><span class="source" id="knowledge-count"></span></div>
      <div class="article-list" id="article-list">${loadingRow(t.loading)}</div>
    </article>`;
  const list = body.querySelector('#article-list');
  let articles = [];
  const renderList = () => {
    const term = body.querySelector('#knowledge-search').value.trim().toLowerCase();
    const visible = term ? articles.filter((item) => [item.question, item.answer, item.category, ...(item.keywords || [])].some((value) => value?.toLowerCase().includes(term))) : articles;
    body.querySelector('#knowledge-count').textContent = `${visible.length} ${t.articles.toLowerCase()}`;
    list.innerHTML = visible.length ? visible.map((item) => `
      <div class="article-row" data-id="${item.id}">
        <div class="article-main">
          <strong>${esc(item.question)}</strong>
          <p>${esc(item.answer.slice(0, 160))}${item.answer.length > 160 ? '…' : ''}</p>
          <div class="article-tags">
            ${item.category ? `<span class="tag">${esc(item.category)}</span>` : ''}
            ${(item.keywords || []).map((keyword) => `<span class="tag tag-light">${esc(keyword)}</span>`).join('')}
            ${item.is_active ? '' : `<span class="tag tag-inactive">${esc(t.inactive)}</span>`}
            ${item.source === 'correction' ? `<span class="tag tag-warn">${esc(t.fromCorrection)}</span>` : ''}
          </div>
        </div>
        <div class="article-side"><span class="usage-count">${esc(item.usage_count)} ${esc(t.uses)}</span></div>
      </div>`).join('') : emptyRow(t.noArticles);
  };
  body.querySelector('#knowledge-search').addEventListener('input', renderList);
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.article-row');
    if (row && can('agent')) openArticleForm(t, articles.find((item) => item.id === row.dataset.id), () => ctx.refresh());
  });
  try { articles = await listArticles(); renderList(); } catch (error) { list.innerHTML = emptyRow(error.message); }
}

function mountDocuments(body, ctx) {
  const { t } = ctx;
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="table-toolbar"><span class="source">${esc(t.documentsHelp)}</span></div>
      <div class="simple-list" id="document-list">${loadingRow(t.loading)}</div>
    </article>`;
  const list = body.querySelector('#document-list');
  let documents = [];
  const load = async () => {
    try {
      documents = await listDocuments();
      list.innerHTML = documents.length ? documents.map((document) => `
        <div class="list-row">
          <div><strong>${esc(document.title)}</strong>
          <small>${esc(t[`sourceType_${document.source_type}`])} · ${esc(formatDateTime(document.created_at))} · ${esc(document.chunk_count)} ${esc(t.chunks)}${document.error ? ` · <span class="danger-text">${esc(document.error)}</span>` : ''}</small></div>
          <div class="row-actions">
            <span class="status ${esc(document.status)}">${esc(t[`docStatus_${document.status}`] || document.status)}</span>
            ${can('agent') ? `<button class="ghost-btn" data-reindex="${document.id}">${esc(t.reindex)}</button>` : ''}
            ${can('admin') ? `<button class="ghost-btn danger-text" data-delete="${document.id}">${esc(t.delete)}</button>` : ''}
          </div>
        </div>`).join('') : emptyRow(t.noDocuments);
    } catch (error) { list.innerHTML = emptyRow(error.message); }
  };
  list.addEventListener('click', async (event) => {
    const reindexId = event.target.closest('[data-reindex]')?.dataset.reindex;
    const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
    try {
      if (reindexId) { event.target.disabled = true; await ingestDocument(reindexId); toast(t.reindexed, 'success'); load(); }
      if (deleteId && await confirmDialog(t.deleteConfirm)) { await deleteDocument(documents.find((item) => item.id === deleteId)); load(); }
    } catch (error) { toastError(error); load(); }
  });
  load();
  const poll = setInterval(() => { if (documents.some((item) => ['pending', 'processing'].includes(item.status))) load(); }, 5000);
  return () => clearInterval(poll);
}

async function mountUnanswered(body, ctx) {
  const { t } = ctx;
  body.innerHTML = `
    <article class="panel table-panel">
      <div class="table-toolbar"><span class="source">${esc(t.unansweredHelp)}</span></div>
      <div class="simple-list" id="unanswered-list">${loadingRow(t.loading)}</div>
    </article>`;
  const list = body.querySelector('#unanswered-list');
  let items = [];
  try { items = await listUnanswered(); } catch (error) { list.innerHTML = emptyRow(error.message); return; }
  list.innerHTML = items.length ? items.map((item) => `
    <div class="list-row">
      <div><strong>${esc(item.question)}</strong><small>${esc(t.askedTimes.replace('{count}', item.occurrences))} · ${esc(timeAgo(item.last_asked_at))}${item.conversation_id ? ` · <a class="link" href="${href('conversations', item.conversation_id)}">${esc(t.viewConversation)}</a>` : ''}</small></div>
      ${can('agent') ? `<div class="row-actions"><button class="create small" data-answer="${item.id}">${esc(t.writeAnswer)}</button><button class="ghost-btn" data-ignore="${item.id}">${esc(t.ignore)}</button></div>` : ''}
    </div>`).join('') : emptyRow(t.noUnanswered);
  list.addEventListener('click', async (event) => {
    const answerId = event.target.closest('[data-answer]')?.dataset.answer;
    const ignoreId = event.target.closest('[data-ignore]')?.dataset.ignore;
    if (answerId) {
      const item = items.find((entry) => entry.id === answerId);
      openArticleForm(t, { question: item.question }, async (saved) => {
        await setUnansweredStatus(item.id, 'resolved', saved?.id);
        ctx.refresh();
      });
    }
    if (ignoreId) {
      try { await setUnansweredStatus(ignoreId, 'ignored'); ctx.refresh(); } catch (error) { toastError(error); }
    }
  });
}

export function create(ctx) {
  openArticleForm(ctx.t, {}, () => ctx.refresh());
}
