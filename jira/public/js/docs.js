'use strict';

// Docs view: Confluence pages and attachments across the listed tasks.

// --- docs ---

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

  const dir = state.docsOrder === 'asc' ? 1 : -1;
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0) * dir;
  const pageSorters = {
    name: (a, b) => cmp(docTitle(a.doc).toLowerCase(), docTitle(b.doc).toLowerCase()),
    date: (a, b) => cmp(a.issues.length, b.issues.length), // pages carry no own date; fall back to relevance
    size: (a, b) => cmp(a.issues.length, b.issues.length),
    task: (a, b) => cmp(a.issues[0]?.key || '', b.issues[0]?.key || ''),
  };
  const attachmentSorters = {
    name: (a, b) => cmp(a.filename.toLowerCase(), b.filename.toLowerCase()),
    date: (a, b) => cmp(a.created || '', b.created || ''),
    size: (a, b) => cmp(a.size || 0, b.size || 0),
    task: (a, b) => cmp(a.issue.key, b.issue.key),
  };
  const sortedPages = matchedPages.slice().sort(pageSorters[state.docsSort] || pageSorters.date);
  const sortedAttachments = matchedAttachments.slice().sort(attachmentSorters[state.docsSort] || attachmentSorters.date);

  // On tasks.html this opens the detail drawer in place; elsewhere (docs.html) it navigates
  // to the task list with that issue's drawer open (see app-docs.js).
  const issueChip = (i) =>
    h('button', { class: 'issue-chip', title: i.summary, onClick: () => openIssueChip(i.key) }, h('span', { class: `dot tone-${tone(i.status)}` }), i.key);

  const kindOption = (val, label) =>
    h(
      'button',
      {
        'aria-selected': String(state.docsKind === val),
        onClick: () => {
          state.docsKind = val;
          syncUrl();
          render();
        },
      },
      label,
    );

  const sortSelect = h(
    'select',
    {
      'aria-label': 'Sort by',
      onChange: (e) => {
        state.docsSort = e.target.value;
        syncUrl();
        render();
      },
    },
    h('option', { value: 'date' }, 'Sort: Date'),
    h('option', { value: 'name' }, 'Sort: Name'),
    h('option', { value: 'size' }, 'Sort: Size'),
    h('option', { value: 'task' }, 'Sort: Task'),
  );
  sortSelect.value = state.docsSort;

  const toolbar = h(
    'div',
    { class: 'docs-toolbar' },
    h('input', {
      type: 'search',
      class: 'docs-search',
      placeholder: 'Search pages, files, task key…',
      'aria-label': 'Search docs',
      value: state.docsQ,
      onInput: (e) => {
        state.docsQ = e.target.value;
        syncUrl();
        render();
      },
    }),
    h(
      'div',
      { class: 'seg', role: 'group', 'aria-label': 'Filter by kind' },
      kindOption('all', 'All'),
      kindOption('pages', 'Confluence'),
      kindOption('attachments', 'Attachments'),
    ),
    sortSelect,
    h(
      'button',
      {
        class: 'icon-btn outline',
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

  return h(
    'div',
    null,
    toolbar,
    showPages && h('h2', { class: 'section-title' }, 'Trang Confluence', h('span', { class: 'muted small' }, sortedPages.length)),
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
    showAttachments && h('h2', { class: 'section-title' }, 'Jira attachments', h('span', { class: 'muted small' }, sortedAttachments.length)),
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
