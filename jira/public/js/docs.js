'use strict';

// Docs view: Confluence pages and attachments across the listed tasks.

// --- docs ---

function renderDocs(list) {
  const pages = new Map();
  for (const i of list) {
    for (const d of i.docs) {
      const k = d.pageId || d.url;
      if (!pages.has(k)) pages.set(k, { doc: d, issues: [] });
      pages.get(k).issues.push(i);
    }
  }
  const attachments = list.flatMap((i) => i.attachments.map((a) => ({ ...a, issue: i })));

  const issueChip = (i) =>
    h('button', { class: 'issue-chip', title: i.summary, onClick: () => openDetail(i.key) }, h('span', { class: `dot tone-${tone(i.status)}` }), i.key);

  return h(
    'div',
    null,
    h('h2', { class: 'section-title' }, 'Trang Confluence', h('span', { class: 'muted small' }, pages.size)),
    pages.size
      ? h(
          'div',
          { class: 'doc-grid' },
          [...pages.values()]
            .sort((a, b) => b.issues.length - a.issues.length)
            .map(({ doc, issues }) =>
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
      : h('div', { class: 'empty-state', style: 'margin-bottom:28px' }, 'No tasks link to this Confluence page.'),
    h('h2', { class: 'section-title' }, 'Jira attachments', h('span', { class: 'muted small' }, attachments.length)),
    attachments.length
      ? h(
          'ul',
          { class: 'link-list' },
          attachments.map((a) =>
            h(
              'li',
              null,
              icon('clip'),
              h('a', { href: a.url, target: '_blank', rel: 'noopener', title: a.filename }, a.filename),
              h('span', { class: 'muted small' }, fmtSize(a.size)),
              h('span', { class: 'tag' }, issueChip(a.issue)),
            ),
          ),
        )
      : h('div', { class: 'empty-state' }, 'No attachments.'),
  );
}
