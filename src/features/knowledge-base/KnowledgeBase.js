import { getKnowledgeBaseArticles } from '../../services/knowledgeBase.js';

export function knowledgeBasePage(t) {
  return `
    <div class="page-heading">
      <div>
        <p class="eyebrow">AI ANSWERS</p>
        <h1>${t.knowledge}</h1>
        <p>${t.knowledgeSubtitle}</p>
        <small id="knowledge-data-source" class="source">Loading live Supabase data…</small>
      </div>
      <button class="create" id="new-article">＋ ${t.newArticle}</button>
    </div>
    <article class="panel knowledge-panel">
      <div class="table-toolbar">
        <input type="search" class="search-input" id="knowledge-search" placeholder="${t.searchArticles}" />
        <span class="source" id="knowledge-count"></span>
      </div>
      <div class="article-list" id="article-list">
        <div class="loading-row">${t.loading}…</div>
      </div>
    </article>`;
}

export async function loadKnowledgeBase(root, t, handlers) {
  const result = await getKnowledgeBaseArticles();
  const source = root.querySelector('#knowledge-data-source');
  const list = root.querySelector('#article-list');
  const count = root.querySelector('#knowledge-count');
  if (!list) return;

  if (source) {
    source.textContent = result.source === 'supabase' ? t.dataLive : t.dataUnavailable;
    source.classList.toggle('live', result.source === 'supabase');
  }

  const renderList = (search = '') => {
    const term = search.toLowerCase();
    const filtered = term
      ? result.items.filter((item) =>
        item.question.toLowerCase().includes(term) ||
        item.answer.toLowerCase().includes(term) ||
        item.category.toLowerCase().includes(term) ||
        item.keywords.some((k) => k.toLowerCase().includes(term)))
      : result.items;

    if (count) count.textContent = `${filtered.length} ${t.articles.toLowerCase()}`;

    list.innerHTML = filtered.length
      ? filtered.map((item) => `
        <div class="article-row" data-id="${item.id}">
          <div class="article-main">
            <strong>${item.question}</strong>
            <p>${item.answer.slice(0, 140)}${item.answer.length > 140 ? '…' : ''}</p>
            <div class="article-tags">
              <span class="tag">${item.category}</span>
              ${item.keywords.map((k) => `<span class="tag tag-light">${k}</span>`).join('')}
              ${item.isActive ? '' : `<span class="tag tag-inactive">${t.inactive}</span>`}
            </div>
          </div>
          <div class="article-side">
            <span class="usage-count">${item.usageCount} ${t.uses}</span>
          </div>
        </div>`).join('')
      : `<div class="loading-row">${t.noArticles}</div>`;

    list.querySelectorAll('.article-row').forEach((row) => {
      row.addEventListener('click', () => handlers?.openArticle?.(row.dataset.id));
    });
  };

  renderList();

  root.querySelector('#knowledge-search')?.addEventListener('input', (event) => {
    renderList(event.target.value);
  });

  root.querySelector('#new-article')?.addEventListener('click', () => handlers?.create?.());
}
