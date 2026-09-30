'use strict';

// The Workspace view: repos, branch cleanup, recent jobs.

// ---------------------------------------------------------------------------
// "Git" view

function renderGitView() {
  if (!gitState.overview && !gitState.loading && !gitState.error) loadGit();
  const ov = gitState.overview;
  const head = h(
    'div',
    { class: 'git-head' },
    h('h2', { class: 'section-title' }, icon('branch'), 'Workspace', ov && h('span', { class: 'muted small' }, ov.root)),
    h('span', { class: 'spacer' }),
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
  if (r.error) return h('div', { class: 'gcard' }, h('h3', null, r.repo), h('div', { class: 'error-box' }, r.error));
  const m = r.main;
  const changed = m.files.length;
  const task = CFG.git.branchTypes.some((t) => (m.branch || '').startsWith(t + '/'));
  return h(
    'div',
    { class: 'gcard' },
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

function cleanupSection() {
  const reasons = (repo, b) =>
    [
      ['merged', 'closed'].includes(mrsOf(gitState.mrData[repo], b.name)[0]?.state) && `MR ${mrsOf(gitState.mrData[repo], b.name)[0].state}`,
      b.kind === 'backup' && 'backup/*',
      b.gone && 'gone on origin',
      b.mergedToUat && `in ${UAT()}`,
      b.kind === 'other' && !isMainBranch(b.name) && 'non-standard name',
    ].filter(Boolean);
  const cols = gitRepos().map((repo) => {
    const data = gitState.branches[repo];
    if (!data) return h('div', { class: 'gcard' }, h('h3', null, repo), h('div', { class: 'muted' }, 'Loading…'));
    const rows = data.branches.filter((b) => !isMainBranch(b.name) && (gitState.cleanupAll || reasons(repo, b).length));
    const boxes = new Map();
    const count = h('span', null, 'Delete selected (0)');
    const allBox = h('input', { type: 'checkbox', 'aria-label': 'Select all', onChange: (e) => (boxes.forEach((b) => (b.checked = e.target.checked)), update()) });
    const update = () => {
      const n = [...boxes.values()].filter((x) => x.checked).length;
      count.textContent = `Delete selected (${n})`;
      allBox.checked = n > 0 && n === boxes.size;
      allBox.indeterminate = n > 0 && n < boxes.size;
    };
    return h(
      'div',
      { class: 'gcard' },
      h(
        'div',
        { class: 'gcard-head' },
        h('h3', null, repo),
        h('span', { class: 'muted small' }, `${rows.length} branch(es)`),
        h('span', { class: 'spacer' }),
        rows.length > 0 && h('label', { class: 'gcheck-all small' }, allBox, 'Select all'),
      ),
      h(
        'ul',
        { class: 'gbranches' },
        rows.length
          ? rows.map((b) => {
              const box = h('input', { type: 'checkbox', disabled: !!b.worktree, title: b.worktree ? `Checked out at ${b.worktree}` : null, onChange: update });
              if (!b.worktree) boxes.set(b.name, box);
              return h(
                'li',
                null,
                h('label', null, box, h('span', { class: 'mono gbname', title: b.name }, b.name)),
                h('span', { class: 'gchips' }, mrsOf(gitState.mrData[repo], b.name).slice(0, 1).map(mrChip), reasons(repo, b).filter((x) => !x.startsWith('MR ')).map((x) => gitChip(x, x === `in ${UAT()}` ? 'ok' : 'warn')), b.worktree && gitChip('checked out', 'accent')),
                h('span', { class: 'muted small' }, rel(new Date(b.date * 1000).toISOString())),
              );
            })
          : h('li', { class: 'muted' }, 'Nothing to clean up.'),
      ),
      h(
        'div',
        { class: 'gstep-act' },
        rows.length > 0 &&
          actBtn(count, () => {
            const names = [...boxes].filter(([, x]) => x.checked).map(([n]) => n);
            if (!names.length) return toast('No branch selected', 'error');
            gitAction(
              { action: 'delete-branches', repo, branches: names },
              `Delete ${names.length} LOCAL branch(es) in ${repo}?\n\n${names.join('\n')}\n\nOrigin is not touched. Each tip is kept under refs/dash-backup/ (restore: git branch <name> refs/dash-backup/<name>/<time>).`,
            );
          }, { danger: true, iconName: 'trash' }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, `${data.backups.total} dashboard backup(s)`),
        data.backups.old > 0 &&
          actBtn(`Prune ${data.backups.old} > ${data.backups.days} days`, () => gitAction({ action: 'prune-backups', repo, days: data.backups.days }, `Delete ${data.backups.old} dashboard backup ref(s) older than ${data.backups.days} days in ${repo}?`)),
      ),
    );
  });
  return h(
    'section',
    { class: 'gsection' },
    h(
      'h2',
      { class: 'section-title' },
      'Clean up local branches',
      h('span', { class: 'spacer' }),
      h(
        'label',
        { class: 'muted small gcheck-all' },
        h('input', {
          type: 'checkbox',
          checked: gitState.cleanupAll,
          onChange: (e) => {
            gitState.cleanupAll = e.target.checked;
            render();
          },
        }),
        'Show all branches',
      ),
    ),
    h('div', { class: 'grepos' }, cols),
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
