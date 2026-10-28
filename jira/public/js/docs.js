'use strict';

// Docs view: Confluence pages and attachments across the listed tasks.

function matchesDocsQ(q, ...fields) {
  if (!q) return true;
  return fields.some((f) => f && String(f).toLowerCase().includes(q));
}

function renderDocs(list) {
  const q = state.docsQ.trim().toLowerCase();
  const pages = new Map();
  for (const i of list) {
    for (const d of i.docs) {
      const k = d.pageId || d.url;
      if (!pages.has(k)) pages.set(k, { doc: d, issues: [] });
      pages.get(k).issues.push(i);
    }
  }
  const allAttachments = list.flatMap((i) => i.attachments.map((a) => ({ ...a, issue: i })));

  const matchedPages = [...pages.values()].filter(
    ({ doc, issues }) => matchesDocsQ(q, docTitle(doc), doc.url) || issues.some((i) => matchesDocsQ(q, i.key, i.summary)),
  );
  const matchedAttachments = allAttachments.filter((a) => matchesDocsQ(q, a.filename, a.issue.key, a.issue.summary));

  const showPages = state.docsKind !== 'attachments';
  const showAttachments = state.docsKind !== 'pages';

  // Confluence pages carry no date or size, so those sorts only make sense for attachments. Offer only the
  // sorts that mean something for what is on screen; a stale choice (e.g. from the URL) falls back to the first.
  const SORT_LABELS = { date: 'Date', name: 'Name', size: 'Size', task: 'Task', links: 'Linked tasks' };
  const sortKeys = state.docsKind === 'pages' ? ['name', 'task', 'links'] : ['date', 'name', 'size', 'task'];
  const sortKey = sortKeys.includes(state.docsSort) ? state.docsSort : sortKeys[0];

  const dir = state.docsOrder === 'asc' ? 1 : -1;
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0) * dir;
  const pageName = (p) => docTitle(p.doc).toLowerCase();
  const pageSorters = {
    name: (a, b) => cmp(pageName(a), pageName(b)),
    task: (a, b) => cmp(a.issues[0]?.key || '', b.issues[0]?.key || ''),
    links: (a, b) => cmp(a.issues.length, b.issues.length),
  };
  // "All" with a date / size sort: those apply to attachments, so pages are listed by name (A-Z) instead.
  const sortPages = pageSorters[sortKey] || ((a, b) => (pageName(a) < pageName(b) ? -1 : pageName(a) > pageName(b) ? 1 : 0));
  const attachmentSorters = {
    name: (a, b) => cmp(a.filename.toLowerCase(), b.filename.toLowerCase()),
    date: (a, b) => cmp(a.created || '', b.created || ''),
    size: (a, b) => cmp(a.size || 0, b.size || 0),
    task: (a, b) => cmp(a.issue.key, b.issue.key),
  };
  const sortedPages = matchedPages.slice().sort(sortPages);
  const sortedAttachments = matchedAttachments.slice().sort(attachmentSorters[sortKey] || attachmentSorters.date);

  // On tasks.html this opens the detail drawer in place; elsewhere (docs.html) it navigates
  // to the task list with that issue's drawer open (see app-docs.js).
  const issueChip = (i) =>
    h('button', { class: 'issue-chip', title: i.summary, onClick: () => openIssueChip(i.key) }, h('span', { class: `dot tone-${tone(i.status)}` }), i.key);

  // Kind filter as pills with match counts, like the status pills on tasks.html.
  const kindPill = (val, label, count, iconName) =>
    h(
      'button',
      {
        class: 'pill',
        'aria-pressed': String(state.docsKind === val),
        onClick: () => {
          state.docsKind = val;
          syncUrl();
          render();
        },
      },
      iconName && icon(iconName),
      label,
      h('b', null, count),
    );

  const sortSelect = h(
    'select',
    {
      class: 'docs-sort',
      'aria-label': 'Sort by',
      onChange: (e) => {
        state.docsSort = e.target.value;
        syncUrl();
        render();
      },
    },
    ...sortKeys.map((k) => h('option', { value: k }, `Sort: ${SORT_LABELS[k]}`)),
  );
  sortSelect.value = sortKey;
  if (state.docsKind === 'all') sortSelect.title = 'Date and size apply to attachments; Confluence pages are listed by name.';

  const toolbar = h(
    'div',
    { class: 'docs-toolbar' },
    h(
      'div',
      { class: 'pills', role: 'group', 'aria-label': 'Filter by kind' },
      kindPill('all', 'All', matchedPages.length + matchedAttachments.length),
      kindPill('pages', 'Confluence', matchedPages.length, 'doc'),
      kindPill('attachments', 'Attachments', matchedAttachments.length, 'clip'),
    ),
    sortSelect,
    h(
      'button',
      {
        class: 'icon-btn sm outline',
        title: state.docsOrder === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending',
        'aria-label': 'Toggle sort order',
        onClick: () => {
          state.docsOrder = state.docsOrder === 'asc' ? 'desc' : 'asc';
          syncUrl();
          render();
        },
      },
      icon(state.docsOrder === 'asc' ? 'sortAsc' : 'sortDesc'),
    ),
  );

  // One line saying whose tasks and which filters the lists below reflect, with a way out of the filters.
  // The user filter is left out of "Clear": it reloads the data, and it lives in the header.
  const sprintName = state.sprint === NO_SPRINT ? 'No sprint' : state.sprint ? state.issues.flatMap(sprintsOf).find((s) => s.id === state.sprint)?.name || `Sprint ${state.sprint}` : null;
  const active = [
    q && `Search: “${state.docsQ.trim()}”`,
    state.docsKind !== 'all' && (state.docsKind === 'pages' ? 'Confluence only' : 'Attachments only'),
    sprintName && sprintName,
  ].filter(Boolean);
  const withDocs = list.filter((i) => i.docs.length || i.attachments.length).length;
  const scope = state.user ? viewedUserName() : 'Mine';
  const context = h(
    'div',
    { class: 'docs-context' },
    h('span', { class: 'muted small' }, `${withDocs} ${withDocs === 1 ? 'task' : 'tasks'} with documents · ${scope}`),
    active.map((t) => h('span', { class: 'docs-ctx-chip' }, t)),
    active.length > 0 &&
      h(
        'button',
        {
          class: 'btn sm',
          onClick: () => {
            state.docsQ = '';
            state.docsKind = 'all';
            state.sprint = null;
            const search = $('#search');
            if (search) search.value = '';
            syncUrl();
            render();
          },
        },
        'Clear filters',
      ),
  );

  return h(
    'div',
    null,
    toolbar,
    context,
    showPages && h('h2', { class: 'section-title' }, 'Confluence pages', h('span', { class: 'muted small' }, sortedPages.length)),
    showPages &&
    sortedPages.length
      ? h(
          'div',
          { class: 'doc-grid' },
          sortedPages.map(({ doc, issues }) =>
            h(
              'div',
              { class: 'doc-card' },
              h(
                'div',
                { class: 'doc-head' },
                h('a', { class: 'doc-title', href: doc.url, target: '_blank', rel: 'noopener' }, icon('doc'), h('span', null, docTitle(doc))),
                h(
                  'button',
                  { class: 'icon-btn sm', title: 'Copy link', onClick: () => copyText(`${docTitle(doc)}: ${doc.url}`, 'Page link copied') },
                  icon('copy'),
                ),
              ),
              h('div', { class: 'muted small doc-url', title: doc.url }, shortUrl(doc.url)),
              h('div', { class: 'issue-chips' }, issues.map(issueChip)),
            ),
          ),
        )
      : showPages && h('div', { class: 'empty-state', style: 'margin-bottom:28px' }, q ? 'No matching Confluence page.' : 'No tasks link to this Confluence page.'),
    showAttachments && h('h2', { class: 'section-title' }, 'Attachments', h('span', { class: 'muted small' }, sortedAttachments.length)),
    showAttachments && sortedAttachments.length
      ? h(
          'ul',
          { class: 'link-list' },
          sortedAttachments.map((a) =>
            h(
              'li',
              null,
              icon('clip'),
              h('a', { href: a.url, target: '_blank', rel: 'noopener', title: a.filename }, a.filename),
              h('span', { class: 'muted small' }, fmtSize(a.size)),
              h('span', { class: 'muted small', title: fmtDate(a.created) }, a.created ? rel(a.created) : ''),
              h('span', { class: 'tag' }, issueChip(a.issue)),
            ),
          ),
        )
      : showAttachments && h('div', { class: 'empty-state' }, q ? 'No matching attachment.' : 'No attachments.'),
  );
}
