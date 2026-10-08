'use strict';

// The Workspace view: repos, branch cleanup, recent jobs.

// ---------------------------------------------------------------------------
// "Git" view

// Header strip on workspace.html: one pill per repo (branch + state) that jumps to its card,
// plus "Fetch all". Kept in the sticky header so repo state stays in view while scrolling.
function renderRepoPills() {
  const box = $('#bar-repos');
  if (!box) return;
  const ov = gitState.overview;
  box.hidden = state.view === 'settings';
  box.title = ov ? ov.root : '';
  const label = (id) => CFG.git.repos.find((r) => r.id === id)?.label || id;
  const jump = (id) => {
    const card = document.getElementById(`gcard-${id}`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth; // restart the animation on repeated clicks
    card.classList.add('flash');
  };
  const pill = (id) => {
    const r = ov?.repos[id];
    const m = r?.main;
    const kids = !r
      ? [gitChip('…')]
      : r.error
        ? [gitChip('error', 'warn', r.error)]
        : [
            h('span', { class: 'repo-pill-branch mono' }, m.branch || 'detached'),
            m.op ? gitChip(m.op, 'warn') : m.files.length ? gitChip(`${m.files.length} changed`, 'warn') : gitChip('clean', 'ok'),
            m.ahead > 0 && gitChip(`↑${m.ahead}`, 'warn'),
            m.behind > 0 && gitChip(`↓${m.behind}`, 'warn'),
          ];
    return h('button', { class: 'repo-pill', title: r && !r.error ? `${label(id)}: ${m.branch || 'detached'}` : label(id), onClick: () => jump(id) }, h('b', null, label(id)), kids);
  };
  const fetchAll = async () => {
    for (const repo of gitRepos()) await gitAction({ action: 'fetch', repo });
  };
  box.replaceChildren(
    h('div', { class: 'repo-pills' }, gitRepos().map(pill)),
    h('button', { class: 'btn sm', title: 'Fetch all repos from origin', onClick: fetchAll }, icon('download'), h('span', { class: 'lbl' }, 'Fetch all')),
  );
}

function renderGitView() {
  if (!gitState.overview && !gitState.loading && !gitState.error) loadGit();
  const ov = gitState.overview;
  const head = h(
    'div',
    { class: 'git-head' },
    gitRepos().some((r) => gitState.mrData[r]?.error) &&
      h('span', { class: 'small warn-text', title: gitRepos().map((r) => `${r}: ${gitState.mrData[r]?.error || 'ok'}`).join('\n') }, 'MR status unavailable (VPN?)'),
    h('span', { class: 'muted small' }, 'Open a task (click its key) for its step-by-step flow.'),
    actBtn('Reload', loadGit, { iconName: 'refresh' }),
  );
  if (gitState.error) return h('div', null, head, h('div', { class: 'error-box' }, gitState.error));
  if (!ov) return h('div', null, head, h('div', { class: 'muted' }, 'Loading…'));

  return h(
    'div',
    { class: 'git-view' },
    head,
    h('div', { class: 'grepos' }, gitRepos().map((r) => repoCard(ov.repos[r]))),
    cleanupSection(),
    jobsSection(),
  );
}

function repoCard(r) {
  if (r.error) return h('div', { class: 'gcard', id: `gcard-${r.repo}` }, h('h3', null, r.repo), h('div', { class: 'error-box' }, r.error));
  const m = r.main;
  const changed = m.files.length;
  const task = CFG.git.branchTypes.some((t) => (m.branch || '').startsWith(t + '/'));
  return h(
    'div',
    { class: 'gcard', id: `gcard-${r.repo}` },
    h('div', { class: 'gcard-head' }, h('h3', null, r.repo), m.branch ? code(m.branch) : gitChip('detached', 'warn'), h('span', { class: 'spacer' }), h('a', { class: 'icon-btn sm', href: r.web, target: '_blank', rel: 'noopener', title: 'Open on GitLab' }, icon('ext'))),
    h(
      'div',
      { class: 'gstep-note' },
      m.op && gitChip(`${m.op} in progress`, 'warn'),
      changed ? gitChip(`${changed} changed`, 'warn') : gitChip('clean', 'ok'),
      m.upstream ? [m.ahead > 0 && gitChip(`↑${m.ahead} to push`, 'warn'), m.behind > 0 && gitChip(`↓${m.behind} behind`, 'warn'), !m.ahead && !m.behind && gitChip(`= ${m.upstream}`)] : gitChip('no upstream'),
      r.fetchedAt && h('span', { class: 'muted small' }, `fetched ${rel(new Date(r.fetchedAt).toISOString())}`),
    ),
    m.op && h('div', { class: 'gconflict' }, h('div', { class: 'gstep-act' }, conflictActions(r.repo, r.dir, m.op))),
    h(
      'div',
      { class: 'gstep-act' },
      changed > 0 && !m.op && actBtn('Commit…', () => openCommitDialog(r.repo), { primary: true }),
      task &&
        (!m.upstream || m.ahead > 0) &&
        (m.behind > 0
          ? forcePushBtn(r.repo, m.branch)
          : actBtn('Push', () => gitAction({ action: 'push', repo: r.repo, branch: m.branch }), { iconName: 'upload' })),
      actBtn('Fetch from origin', () => gitAction({ action: 'fetch', repo: r.repo }), { iconName: 'download', iconOnly: true }),
      actBtn('Open in Cursor', () => openInCursor(r.repo, r.dir), { iconName: 'code', iconOnly: true }),
    ),
    r.stashes?.length > 0 &&
      h(
        'details',
        { class: 'gdetails' },
        h('summary', null, `${r.stashes.length} stash(es)`),
        h(
          'ul',
          { class: 'gwts' },
          r.stashes.map((st) =>
            h(
              'li',
              { class: 'gstash' },
              h('span', { class: 'mono muted' }, st.ref),
              h('span', { class: 'gsubj', title: st.subject }, st.subject),
              h('span', { class: 'muted small' }, rel(st.at)),
              actBtn('Pop', () => gitAction({ action: 'stash-pop', repo: r.repo, ref: st.ref }, `Apply ${st.ref} onto ${m.branch} and drop it?\n\n${st.subject}`)),
            ),
          ),
        ),
      ),
    changed > 0 &&
      h('details', { class: 'gdetails' }, h('summary', null, `${changed} changed file(s)`), h('ul', { class: 'gfiles' }, m.files.map((f) => h('li', { class: 'mono' }, h('span', { class: 'muted' }, f.xy.replace(/\./g, ' '), ' '), f.path)))),
    r.worktrees.length > 0 &&
      h(
        'details',
        { class: 'gdetails', open: r.worktrees.some((w) => w.op) },
        h('summary', null, `${r.worktrees.length} other worktree(s)`),
        h(
          'ul',
          { class: 'gwts' },
          r.worktrees.map((w) =>
            h(
              'li',
              null,
              h('div', null, code(w.path), ' ', w.branch ? code(w.branch) : gitChip('detached'), w.scratch && gitChip('dashboard', '', 'Scratch worktree the dashboard uses'), w.op && gitChip(`${w.op} in progress`, 'warn'), w.dirty > 0 && gitChip(`${w.dirty} changed`, 'warn')),
              w.op ? h('div', { class: 'gstep-act' }, conflictActions(r.repo, w.path, w.op)) : h('div', { class: 'gstep-act' }, actBtn('Open in Cursor', () => openInCursor(r.repo, w.path), { iconName: 'code', iconOnly: true })),
            ),
          ),
        ),
      ),
  );
}

function jobsSection() {
  if (!gitState.jobs.length) return null;
  return h(
    'section',
    { class: 'gsection' },
    h('h2', { class: 'section-title' }, 'Recent git jobs'),
    h(
      'ul',
      { class: 'link-list' },
      gitState.jobs.slice(0, 10).map((j) =>
        h(
          'li',
          { class: 'child', onClick: () => showJob(j.id) },
          gitChip(j.status, j.status === 'ok' ? 'ok' : j.status === 'running' ? 'accent' : 'warn'),
          h('span', null, j.title),
          h('span', { class: 'tag muted small' }, rel(new Date(j.startedAt).toISOString())),
        ),
      ),
    ),
  );
}
