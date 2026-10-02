'use strict';

// Issue detail drawer.

// ---------------------------------------------------------------------------
// Issue detail (in-app; any issue key, not only the listed ones)

async function openDetail(key) {
  if (!ISSUE_KEY_RE.test(key)) return;
  closeMenu();
  state.openKey = key;
  state.openIssue = state.issues.find((i) => i.key === key) || null;
  if (location.hash !== '#' + key) history.replaceState(null, '', '#' + key);
  
  // Track recently viewed
  state.recentlyViewed = [key, ...state.recentlyViewed.filter(k => k !== key)].slice(0, 10);
  LS.set('recentlyViewed', state.recentlyViewed);
  
  const drawer = $('#drawer');
  drawer.classList.toggle('wide', state.wide);
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;

  if (state.openIssue) renderDetail(state.openIssue, null);
  else drawer.replaceChildren(detailHead(null, key), h('div', { class: 'drawer-body' }, h('div', { class: 'muted' }, 'Loading…')));

  try {
    const d = await getDetail(key);
    if (state.openKey !== key) return;
    if (!state.openIssue) state.openIssue = d.issue;
    renderDetail(state.openIssue, d);
  } catch (e) {
    if (state.openKey !== key) return;
    const body = $('.drawer-body', drawer);
    body?.append(h('div', { class: 'error-box' }, e.message, e.login && h('a', { class: 'btn primary', href: '/oauth/login' }, 'Sign in to Atlassian')));
    $('[data-slot="loading"]', drawer)?.remove();
  }
}

function detailHead(issue, key) {
  const jiraUrl = issue?.url;
  return h(
    'div',
    { class: 'drawer-head' },
    h(
      'button',
      {
        class: 'icon-btn expand-toggle',
        title: state.wide ? 'Shrink' : 'Expand to full screen',
        onClick: () => {
          state.wide = !state.wide;
          LS.set('wide', state.wide);
          openDetail(key);
        },
      },
      icon(state.wide ? 'shrink' : 'expand'),
    ),
    issue && typeBadge(issue.type.name),
    h('span', { class: 'key' }, key),
    h('span', { id: 'drawer-status' }),
    h('span', { class: 'spacer' }),
    jiraUrl && h('button', { class: 'icon-btn', title: 'Copy Jira link', 'aria-label': 'Copy Jira link', onClick: () => copyText(jiraUrl, 'Link copied') }, icon('link')),
    issue &&
      h(
        'button',
        {
          class: 'icon-btn',
          title: 'Copy for AI: link, docs, MR, subtasks, description, comments (Markdown)',
          'aria-label': 'Copy for AI',
          onClick: async () => {
            const d = await getDetail(key).catch(() => null);
            copyText(issueMarkdown(issue, d), `Copied ${key} (with description) — paste into AI to read`);
          },
        },
        icon('copy'),
      ),
    issue &&
      (/epic/i.test(issue.type?.name || '')
        ? h(
            'button',
            { class: 'btn sm', title: 'Open a new Claude Code tab in Cursor with this epic', onClick: async () => sendToClaude(issue, await getDetail(key).catch(() => null)) },
            icon('ai'),
            h('span', { class: 'btn-label' }, 'Claude Code'),
          )
        : h('button', { class: 'btn sm primary', title: 'Start with Claude: choose repos / MRs, then open Claude Code in Cursor', onClick: () => startWithClaude(issue) }, icon('ai'), h('span', { class: 'btn-label' }, 'Claude'))),
    jiraUrl && h('a', { class: 'icon-btn', href: jiraUrl, target: '_blank', rel: 'noopener', title: 'Open in Jira' }, icon('ext')),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', onClick: closeDrawer }, icon('x')),
  );
}

function renderDetail(issue, d) {
  const drawer = $('#drawer');
  const scroll = $('.drawer-body', drawer)?.scrollTop || 0;
  const p = issue.parent;
  const loading = h('div', { class: 'muted small', 'data-slot': 'loading' }, 'Loading detail…');

  const docs = [...(d?.issue?.docs || issue.docs), ...(d?.confluence || [])].filter(
    (x, idx, arr) => arr.findIndex((y) => (y.pageId || y.url) === (x.pageId || x.url)) === idx,
  );

  const block = (iconName, title, count, content) =>
    h('section', { class: 'block' }, h('h3', null, iconName && icon(iconName), title, count != null && h('span', { class: 'n' }, count)), content);

  // One compact line of facts; the drawer's space goes to git, description and comments.
  const fact = (label, ...value) => h('span', { class: 'fact' }, h('span', { class: 'fact-l' }, label), ...value);
  const meta = h(
    'div',
    { class: 'meta-line' },
    fact('Type', typeBadge(issue.type.name), issue.type.name),
    fact('Priority', prio(issue.priority), issue.priority || '—'),
    issue.storyPoints && fact('SP', String(issue.storyPoints)),
    issue.due && fact('Due', fmtDay(issue.due), dueBadge(issue)),
    d && fact('Assignee', d.assignee || '—'),
    d?.reporter && fact('Reporter', d.reporter),
    p && fact('Parent', h('a', { class: 'key', href: '#' + p.key, onClick: (e) => (e.preventDefault(), openDetail(p.key)) }, p.key), h('span', { class: 'fact-sum', title: p.summary }, p.summary)),
    issue.labels.length > 0 && fact('Labels', issue.labels.map((l) => h('span', { class: 'badge' }, l))),
    h('span', { class: 'fact muted small' }, `Updated ${rel(issue.updated)} · created ${fmtDate(issue.created)}`),
  );

  const docsList = h(
    'ul',
    { class: 'link-list' },
    docs.length
      ? docs.map((x) =>
          h(
            'li',
            null,
            icon('doc'),
            h('a', { href: x.url, target: '_blank', rel: 'noopener', title: x.url }, docTitle(x)),
            x.from && x.from !== issue.key && h('span', { class: 'tag muted small' }, `from ${x.from}`),
            h('button', { class: 'icon-btn sm', title: 'Copy link', onClick: () => copyText(`${docTitle(x)}: ${x.url}`, 'Page link copied') }, icon('copy')),
          ),
        )
      : h('li', { class: 'muted' }, 'No linked Confluence pages.'),
  );

  const side = h(
    'div',
    { class: 'detail-side' },
    docs.length > 0 && block('doc', 'Confluence docs', docs.length, docsList),
    issue.attachments.length > 0 &&
      block(
        'clip',
        'Attachments',
        issue.attachments.length,
        h(
          'ul',
          { class: 'link-list' },
          issue.attachments.map((a) =>
            h('li', null, icon('clip'), h('a', { href: a.url, target: '_blank', rel: 'noopener', title: a.filename }, a.filename), h('span', { class: 'tag muted small' }, fmtSize(a.size))),
          ),
        ),
      ),
    d?.children.length > 0 &&
      block(
        'tree',
        'Subtasks',
        d.children.length,
        h(
          'ul',
          { class: 'link-list' },
          d.children.map((c) =>
            h(
              'li',
              { class: 'child', onClick: () => openDetail(c.key) },
              typeBadge(c.type),
              h('span', { class: 'key' }, c.key),
              h('span', { class: 'child-summary', title: c.summary }, c.summary),
              h('span', { class: 'tag' }, statusButton(c)),
            ),
          ),
        ),
      ),
    // MRs and commits live in the Git block (with GitLab state); only other links are listed here.
    d?.links.some((l) => l.kind === 'other') && block('link', 'Links', null, renderLinks(d.links.filter((l) => l.kind === 'other'))),
  );

  const main = h(
    'div',
    { class: 'detail-main' },
    block(null, 'Description', null, d ? (d.descriptionHtml ? htmlFrame(d.descriptionHtml, siteOf(issue)) : h('div', { class: 'muted small' }, 'No description.')) : loading),
    d && block('chat', 'Comments', d.comments.length, d.comments.length ? htmlFrame(commentsHtml(d.comments), siteOf(issue)) : h('div', { class: 'muted small' }, 'No comments yet.')),
  );

  drawer.replaceChildren(
    detailHead(issue, issue.key),
    h(
      'div',
      { class: 'drawer-body' },
      h('h2', { class: 'detail-title' }, issue.summary),
      urgency(issue).reasons.length > 0 && h('div', { class: 'row-reasons' }, reasonChips(issue)),
      meta,
      // Git is what you act on: right under the title (git.js missing on an old server: skipped).
      typeof gitFlowBlock === 'function' && gitFlowBlock(issue, d),
      h('div', { class: `detail-grid${side.childElementCount ? '' : ' no-side'}` }, side.childElementCount ? side : null, main),
    ),
  );
  refreshDrawerStatus();
  $('.drawer-body', drawer).scrollTop = scroll;
}

function commentsHtml(comments) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return comments
    .map((c) => `<div class="c"><div class="c-head"><b>${esc(c.author)}</b> · ${esc(fmtDate(c.created))}</div>${c.html}</div>`)
    .join('');
}

function refreshDrawerStatus() {
  const slot = $('#drawer-status');
  const issue = state.issues.find((i) => i.key === state.openKey) || state.openIssue;
  if (slot && issue && issue.key === state.openKey) slot.replaceChildren(statusButton(issue));
}

function renderLinks(links) {
  if (!links.length) return h('div', { class: 'muted small' }, 'No links.');
  const item = (l) =>
    h(
      'li',
      null,
      icon(l.kind === 'mr' ? 'mr' : l.kind === 'commit' ? 'commit' : 'link'),
      h('a', { href: l.url, target: '_blank', rel: 'noopener', title: l.url }, l.title),
      l.source && h('span', { class: 'tag muted small' }, l.source),
    );
  const mrs = links.filter((l) => l.kind === 'mr');
  const other = links.filter((l) => l.kind === 'other');
  const commits = links.filter((l) => l.kind === 'commit');
  return h(
    'div',
    null,
    mrs.length + other.length > 0 && h('ul', { class: 'link-list' }, [...mrs, ...other].map(item)),
    commits.length > 0 && h('details', null, h('summary', null, `${commits.length} commit`), h('ul', { class: 'link-list' }, commits.map(item))),
  );
}

// Jira-rendered HTML goes into a sandboxed iframe (no scripts), styled with our theme tokens.
function htmlFrame(html, site) {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const frame = h('iframe', {
    class: 'desc',
    title: 'Content',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  });
  const base = h('base', { href: site + '/', target: '_blank' }).outerHTML;
  frame.srcdoc = `<!doctype html><html><head>${base}<style>
    body{margin:0;padding:12px 14px;font:13.5px/1.6 system-ui,sans-serif;color:${v('--text')};background:${v('--surface')};word-wrap:break-word}
    a{color:${v('--accent')}} img{max-width:100%;height:auto}
    code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;background:${v('--surface-2')};border-radius:4px}
    code{padding:1px 4px} pre{padding:10px;overflow:auto}
    table{border-collapse:collapse} td,th{border:1px solid ${v('--border')};padding:4px 8px}
    h1,h2,h3,h4{margin:1em 0 .4em;line-height:1.3} h2{font-size:16px} h3{font-size:14.5px}
    p{margin:.4em 0} ul,ol{padding-left:1.4em}
    .c{padding:10px 0;border-bottom:1px solid ${v('--border')}} .c:last-child{border:0} .c-head{color:${v('--muted')};font-size:12.5px;margin-bottom:4px}
  </style></head><body>${html}</body></html>`;
  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (doc) frame.style.height = doc.documentElement.scrollHeight + 2 + 'px';
  });
  return frame;
}

function closeDrawer() {
  state.openKey = null;
  state.openIssue = null;
  const drawer = $('#drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
