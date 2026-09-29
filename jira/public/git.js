'use strict';

// Git flow UI for the LMS repos: the "Git flow" block in an issue's drawer and the "Git" view
// (repos, tickets in flight, branch cleanup, recent jobs). Server side: ../git.js.
// Loaded before app.js and only defines functions; they use app.js helpers (h, icon, api, toast…) at call time.

const GIT_REPOS = ['backend', 'frontend'];
const MR_CHECKLIST = [
  'MR title is clear and follows team conventions',
  'No debug logs / console noise left behind',
  'TypeScript types updated (no `any` unless justified)',
  'Tests added/updated (or not needed with explanation)',
  'Build packages successfully',
  'Build corresponding app successfully (admin / learner / others)',
  'Translations updated if applicable (e.g. `sites/**/locales/{en,vi}.json`)',
  'Accessibility considered (keyboard navigation, labels, contrast) for UI changes',
  'Error states handled (loading/empty/error)',
  'Security/permissions considered (no sensitive data in logs, correct authz)',
  'Docs updated if needed (README / docs / inline comments)',
];

const gitState = {
  overview: null,
  branches: {},
  jobs: [],
  loading: false,
  error: null,
  flows: new Map(), // `${key}|${epic}` → Promise<flow>
  mrs: new Map(), // repo → Promise<{ byBranch, error }>
  mrData: {}, // repo → resolved value of the above
  mrStale: new Set(),
  epics: new Map(), // epic key → Promise<epic view>
  epicOpen: new Set(), // `${repo}:${ticket}` rows expanded in the epic view
  epicTitles: new Map(), // epic key → { ticket: summary }
  cleanupAll: false,
};

// ---------------------------------------------------------------------------
// Data

function epicOverride(key) {
  return LS.get('gitEpic', {})[key] || '';
}

function getFlow(key, { fresh = false } = {}) {
  const epic = epicOverride(key);
  const id = `${key}|${epic}`;
  if (fresh || !gitState.flows.has(id)) {
    const p = api(`/api/git/flow?key=${encodeURIComponent(key)}${epic ? '&epic=' + encodeURIComponent(epic) : ''}`);
    p.catch(() => gitState.flows.delete(id));
    gitState.flows.set(id, p);
  }
  return gitState.flows.get(id);
}

// Merge requests per repo from GitLab (via the server's glab login). Slow or failing when off VPN, so never awaited by a render.
function getMrs(repo) {
  const fresh = gitState.mrStale.delete(repo);
  if (fresh || !gitState.mrs.has(repo)) {
    const p = api(`/api/git/mrs?repo=${repo}${fresh ? '&fresh=1' : ''}`)
      .catch((e) => ({ repo, byBranch: null, error: e.message }))
      .then((d) => (gitState.mrData[repo] = d));
    gitState.mrs.set(repo, p);
  }
  return gitState.mrs.get(repo);
}

const MR_STATE = { opened: ['open', 'accent'], merged: ['merged', 'ok'], closed: ['closed', 'gone'], locked: ['locked', 'warn'] };
const mrsOf = (data, branch, target) => (data?.byBranch?.[branch] || []).filter((m) => !target || m.target === target);
const mrLabel = (m) => (m.state === 'opened' && m.draft ? 'draft' : MR_STATE[m.state]?.[0] || m.state);

// GitLab's detailed_merge_status → words (only the ones worth showing on an open MR).
const MERGE_STATUS = {
  mergeable: 'ready to merge',
  conflict: 'conflict',
  need_rebase: 'needs rebase',
  ci_must_pass: 'pipeline must pass',
  ci_still_running: 'pipeline running',
  not_approved: 'needs approval',
  discussions_not_resolved: 'unresolved threads',
  draft_status: 'draft',
  checking: 'checking…',
  unchecked: 'checking…',
};

// What a reviewer / author needs to know about an open MR: conflicts, comments, unresolved threads, merge readiness.
function mrFacts(m) {
  if (!m) return [];
  const out = [];
  if (m.state === 'opened' && m.conflicts) out.push(gitChip('⚠ conflict', 'danger', 'The MR has merge conflicts with its target branch'));
  if (m.comments) out.push(gitChip(`💬 ${m.comments}`, '', `${m.comments} comment(s) on the MR`));
  if (m.state === 'opened' && !m.resolved) out.push(gitChip('unresolved threads', 'warn', 'Some review threads that block merging are not resolved'));
  const st = m.state === 'opened' && MERGE_STATUS[m.status];
  if (st && !['conflict', 'unresolved threads', 'draft'].includes(st)) out.push(gitChip(st, st === 'ready to merge' ? 'ok' : ''));
  return out;
}

const mrFactsText = (m) =>
  [m.state === 'opened' && m.conflicts && 'CONFLICT', m.comments && `${m.comments} comment(s)`, m.state === 'opened' && !m.resolved && 'unresolved threads', m.state === 'opened' && MERGE_STATUS[m.status]]
    .filter(Boolean)
    .join(' · ');

function mrChip(m) {
  const facts = mrFactsText(m);
  return h(
    'a',
    {
      class: `gchip mrchip ${m.state === 'opened' && m.conflicts ? 'danger' : MR_STATE[m.state]?.[1] || ''}`,
      href: m.url,
      target: '_blank',
      rel: 'noopener',
      title: `!${m.iid} ${m.title}\n→ ${m.target} · ${m.author} · updated ${fmtDate(m.updated)}${facts ? '\n' + facts : ''}`,
    },
    icon('mr'),
    `!${m.iid} ${mrLabel(m)}`,
    m.state === 'opened' && m.conflicts && ' · conflict',
    m.comments > 0 && ` · 💬${m.comments}`,
  );
}

async function loadGit() {
  if (gitState.loading) return;
  gitState.loading = true;
  try {
    const [overview, jobs, ...branches] = await Promise.all([
      api('/api/git/overview'),
      api('/api/git/jobs'),
      ...GIT_REPOS.map((r) => api(`/api/git/branches?repo=${r}`)),
    ]);
    gitState.overview = overview;
    gitState.jobs = jobs.jobs;
    gitState.branches = Object.fromEntries(branches.map((b) => [b.repo, b]));
    gitState.error = null;
  } catch (e) {
    gitState.error = e.message;
  } finally {
    gitState.loading = false;
    if (state.view === 'git') render();
  }
  for (const r of GIT_REPOS) getMrs(r).then(() => state.view === 'git' && render());
}

// After a job: drop cached flows and redraw whatever shows git state.
function refreshGit() {
  gitState.flows.clear();
  gitState.epics.clear();
  loadGitSummary();
  gitState.mrs.clear();
  for (const r of GIT_REPOS) gitState.mrStale.add(r);
  if (state.view === 'git') loadGit();
  const block = $('#git-flow');
  const issue = state.issues.find((i) => i.key === state.openKey) || state.openIssue;
  if (block && issue) block.replaceWith(gitFlowBlock(issue));
}

const ACTION_TITLES = {
  'ensure-epic': 'Create epic',
  'create-task': 'Create branch',
  checkout: 'Checkout',
  push: 'Push',
  'sync-task': 'Rebase onto epic',
  'rebase-epic': 'Rebase epic onto uat',
  'pick-develop': 'Cherry-pick to develop',
  skip: 'Skip commit',
  abort: 'Abort',
  undo: 'Undo',
  'delete-branches': 'Delete branches',
  'prune-backups': 'Prune backups',
  'stash-pop': 'Pop stash',
};
const DANGER_ACTIONS = new Set(['rebase-epic', 'abort', 'undo', 'delete-branches', 'prune-backups']);

async function gitAction(body, confirmText) {
  if (confirmText) {
    const ok = await confirmPop(confirmText, {
      title: ACTION_TITLES[body.action] ? `${ACTION_TITLES[body.action]}${body.force ? ' (force)' : ''}?` : 'Continue?',
      okLabel: body.force ? 'Force-push' : ACTION_TITLES[body.action] || 'Confirm',
      danger: DANGER_ACTIONS.has(body.action) || !!body.force,
    });
    if (!ok) return;
  }
  try {
    const { id } = await api('/api/git/action', { method: 'POST', body: JSON.stringify(body) });
    return await showJob(id);
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

async function openInCursor(repo, dir) {
  try {
    await api('/api/git/open', { method: 'POST', body: JSON.stringify({ repo, dir }) });
    toast(`Opening ${dir} in Cursor`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Small pieces

const gitChip = (text, kind = '', title) => h('span', { class: `gchip ${kind}`, title }, text);
const code = (text) => h('code', { class: 'gcode', title: text }, text);
const ticketOf = (branch) => (branch || '').match(/VLEARN-\d+/)?.[0] || null;

function slugify(text, words = 6) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, words)
    .join('-')
    .slice(0, words * 8)
    .replace(/-+$/, '');
}

function mrUrl(web, source, target, title, description) {
  const q = new URLSearchParams({
    'merge_request[source_branch]': source,
    'merge_request[target_branch]': target,
    'merge_request[title]': title,
    'merge_request[description]': description,
  });
  return `${web}/-/merge_requests/new?${q}`;
}

const mrListUrl = (web, source) => `${web}/-/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(source)}`;

function mrDescription(key, epicBranch, devBranch) {
  return [
    '## Summary', '', '', '## Changes', '', '- ', '', '## Test cases', '', '- [ ] ', '',
    '## Checklist', '', ...MR_CHECKLIST.map((c) => `- [ ] ${c}`), '',
    '## Related issues / links', '',
    `- Epic: \`${epicBranch}\``,
    devBranch && `- Develop branch: \`${devBranch}\``,
    `- Ticket: ${key}`,
  ]
    .filter((l) => typeof l === 'string')
    .join('\n');
}

const linkBtn = (href, label, primary) =>
  h('a', { class: `btn sm${primary ? ' primary' : ''}`, href, target: '_blank', rel: 'noopener' }, icon('mr'), label);

const actBtn = (label, onClick, { primary, danger, iconName, title, disabled } = {}) =>
  h('button', { class: `btn sm${primary ? ' primary' : ''}${danger ? ' danger' : ''}`, title, disabled, onClick }, iconName && icon(iconName), label);

// Buttons shown wherever a rebase / cherry-pick is stopped on a conflict.
function conflictActions(repo, dir, op) {
  return [
    actBtn('Open in Cursor', () => openInCursor(repo, dir), { iconName: 'code' }),
    actBtn('Continue', () => gitAction({ action: 'continue', repo, dir }), { primary: true, title: 'Stage the resolved files and continue' }),
    actBtn('Skip commit', () => gitAction({ action: 'skip', repo, dir }, `Skip the current commit of this ${op}?`)),
    actBtn('Abort', () => gitAction({ action: 'abort', repo, dir }, `Abort the ${op} and go back to where it started?`), { danger: true }),
  ];
}

// ---------------------------------------------------------------------------
// Task list: one-click start

gitState.summary = null; // { backend: { tickets }, frontend: { tickets } }

async function loadGitSummary() {
  const keys = state.issues.map((i) => i.key);
  if (!keys.length) return;
  try {
    const d = await api(`/api/git/summary?keys=${keys.join(',')}`);
    gitState.summary = d.repos;
  } catch {
    return; // git status is a bonus on the list; the list works without it
  }
  if (state.view === 'list') render();
}

// Task rows only get a "Start" button when the ticket has no branch in either repo; its git state lives in the drawer.
function gitCell(issue) {
  if (!gitState.summary || GIT_REPOS.some((r) => gitState.summary[r]?.tickets?.[issue.key])) return null;
  // Only for work not started / in development; later statuses can still start from the drawer.
  if (!(issue.status.category === 'new' || /develop|progress/i.test(issue.status.name))) return null;
  return h(
    'button',
    {
      class: 'gstart',
      title: `Start ${issue.key}: create the task branch off its epic and check it out`,
      onClick: (e) => {
        e.stopPropagation();
        startTaskPop(issue);
      },
    },
    icon('branch'),
    'Start',
  );
}

// Everything needed to start coding a ticket, in one popover: type + short description (+ BE/FE, stash, Jira status).
async function startTaskPop(issue, { repos, preset } = {}) {
  const form = branchForm(issue, preset);
  const named = /^\W*FE\b/i.test(issue.summary) ? ['frontend'] : /^\W*BE\b/i.test(issue.summary) ? ['backend'] : null;
  const pickRepos = repos || named || ['backend'];
  const repoBoxes = GIT_REPOS.map((r) => h('input', { type: 'checkbox', value: r, checked: pickRepos.includes(r) }));
  const stash = h('input', { type: 'checkbox', checked: true });
  const jira = h('input', { type: 'checkbox', checked: issue.status?.category === 'new' });
  const opts = h(
    'div',
    { class: 'gstart-opts' },
    h('div', { class: 'gchecks' }, GIT_REPOS.map((r, i) => h('label', null, repoBoxes[i], r === 'backend' ? 'Backend' : 'Frontend'))),
    h('label', null, stash, 'Stash uncommitted changes & checkout'),
    issue.status && issue.status.category !== 'done' && h('label', null, jira, 'Move Jira to In Development'),
  );
  const values = await popover({
    title: `Start ${issue.key}`,
    okLabel: 'Start',
    body: [form.el, opts, h('div', { class: 'muted small' }, 'Off the epic (created from uat if missing). Push & MR come later from the Git flow.')],
    focus: () => form.input,
    onOk: () => {
      const branch = form.branch();
      const picked = repoBoxes.filter((b) => b.checked).map((b) => b.value);
      if (!branch) return void (toast('Type a short description, e.g. add-export', 'error'), form.focus());
      if (!picked.length) return void toast('Pick Backend and/or Frontend', 'error');
      return { branch, repos: picked, stash: stash.checked, jira: jira.checked };
    },
  });
  if (!values) return;
  const job = await gitAction({ action: 'start-task', key: issue.key, epic: epicOverride(issue.key) || undefined, branch: values.branch, repos: values.repos, stash: values.stash });
  if (job?.status === 'ok' && values.jira) moveToInDevelopment(issue);
}

async function moveToInDevelopment(issue) {
  const live = state.issues.find((i) => i.key === issue.key) || issue;
  if (live.status?.category !== 'new') return;
  try {
    const ts = await getTransitions(live.key);
    const t = ts.find((x) => x.to.category === 'indeterminate' && /develop|progress/i.test(x.to.name)) || ts.find((x) => x.to.category === 'indeterminate');
    if (t) await transition(live, t);
    else toast(`${live.key}: no transition to "In progress" available`, 'error');
  } catch (e) {
    toast(`${live.key}: ${e.message}`, 'error');
  }
}

// "type ▾ + short description" → <type>/VLEARN-123-<description>-uat (the -uat suffix is the team rule for task branches).
const BRANCH_TYPES = ['feature', 'bugfix', 'refactor', 'chore', 'docs', 'test'];

function branchForm(issue, preset) {
  const type = h('select', { class: 'gin gtype', 'aria-label': 'Branch type' }, BRANCH_TYPES.map((t) => h('option', { value: t }, t)));
  type.value = /bug/i.test(issue.type.name) ? 'bugfix' : 'feature';
  const desc = h('input', { class: 'gin mono gdesc', placeholder: 'short-description', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Short description' });
  // Reuse an existing branch name (the ticket already has it in the other repo).
  const m = preset?.match(/^([a-z]+)\/[A-Z]+-\d+-(.+)-uat$/);
  if (m && BRANCH_TYPES.includes(m[1])) (type.value = m[1]), (desc.value = m[2]);
  const preview = h('code', { class: 'gcode' });
  const slug = () => slugify(desc.value, 10).replace(/^vlearn-\d+-?/, '');
  const branch = () => (slug() ? `${type.value}/${issue.key}-${slug()}-uat` : '');
  const update = () => (preview.textContent = branch() || `${type.value}/${issue.key}-…-uat`);
  let submit = () => {};
  type.addEventListener('change', update);
  desc.addEventListener('input', update);
  desc.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), submit()));
  update();
  return {
    el: h(
      'div',
      { class: 'gform' },
      h('div', { class: 'gform-row' }, type, h('span', { class: 'mono muted gfix' }, `/${issue.key}-`), desc, h('span', { class: 'mono muted gfix' }, '-uat')),
      h('div', { class: 'gstep-note' }, '→ ', preview),
    ),
    branch,
    input: desc,
    focus: () => desc.focus(),
    onSubmit: (fn) => (submit = fn),
  };
}

// ---------------------------------------------------------------------------
// Issue drawer: where this ticket stands in the flow, per repo

function gitFlowBlock(issue) {
  if (/epic/i.test(issue.type?.name || '')) return epicBlock(issue);
  const box = h(
    'section',
    { class: 'block git-flow', id: 'git-flow' },
    h('h3', null, icon('branch'), 'Git flow'),
    h('div', { class: 'muted small' }, 'Reading git status…'),
  );
  getFlow(issue.key).then(
    (f) => fillFlow(box, issue, f),
    (e) => box.replaceChildren(box.firstChild, h('div', { class: 'error-box' }, e.message)),
  );
  return box;
}

function fillFlow(box, issue, f) {
  const repos = GIT_REPOS.filter((r) => f.repos[r]);
  const used = repos.filter((r) => f.repos[r].uat || f.repos[r].develop || f.repos[r].commits?.length);

  const editEpic = async () => {
    const v = await promptPop(`Epic branch for ${issue.key}`, {
      value: epicOverride(issue.key) || f.epic,
      prefix: 'epic/',
      hint: 'Leave empty to use the parent Epic on Jira (or the ticket itself).',
      okLabel: 'Use epic',
      validate: (x) => (!x.trim() || ISSUE_KEY_RE.test(x.trim().toUpperCase()) ? '' : 'Expected a key like VLEARN-4718'),
    });
    if (v == null) return;
    const all = LS.get('gitEpic', {});
    const next = v.trim().toUpperCase();
    if (next && next !== f.epic) all[issue.key] = next;
    else delete all[issue.key];
    LS.set('gitEpic', all);
    refreshGit();
  };

  const head = h(
    'h3',
    null,
    icon('branch'),
    'Git',
    h('span', { class: 'spacer' }),
    h('button', { class: 'gchip link', title: 'The epic branch this ticket goes into — click to change', onClick: editEpic }, `epic/${f.epic}`, epicOverride(issue.key) ? ' (manual)' : ''),
    h('button', { class: 'icon-btn sm', title: 'Reload git status', onClick: refreshGit }, icon('refresh')),
  );

  // Jira's parent Epic may not be the epic branch the work actually went into.
  const elsewhere = [...new Set(repos.flatMap((x) => f.repos[x].epicsWithTicket || []))].filter((e) => e !== f.epic);
  const onCurrent = repos.some((x) => (f.repos[x].epicsWithTicket || []).includes(f.epic));
  const hint =
    elsewhere.length > 0 &&
    !onCurrent &&
    h(
      'div',
      { class: 'gconflict ghint' },
      h('div', null, `${issue.key} commits are on `, elsewhere.map((e) => code(`epic/${e}`)), ` but not on epic/${f.epic}.`),
      h(
        'div',
        { class: 'gstep-act' },
        elsewhere.map((e) =>
          actBtn(`Use epic/${e}`, () => {
            LS.set('gitEpic', { ...LS.get('gitEpic', {}), [issue.key]: e });
            refreshGit();
          }),
        ),
      ),
    );

  const body = used.length
    ? used.map((repo) => repoCard2(issue, f, f.repos[repo], gitState.mrData[repo], repos.filter((x) => !used.includes(x))))
    : [startPanel(issue, f)];
  box.replaceChildren(...[head, hint, ...body].filter(Boolean));
  // MR states arrive later (GitLab API); redraw once they're in.
  for (const repo of used) {
    if (!gitState.mrData[repo] || !gitState.mrs.has(repo)) getMrs(repo).then(() => box.isConnected && fillFlow(box, issue, f));
  }
}

// ---------------------------------------------------------------------------
// Epic issue: the commits its branch carries (grouped by task MR) and cherry-picking them to develop

function getEpic(key) {
  if (!gitState.epics.has(key)) {
    const p = api(`/api/git/epic?key=${encodeURIComponent(key)}`);
    p.catch(() => gitState.epics.delete(key));
    gitState.epics.set(key, p);
  }
  return gitState.epics.get(key);
}

function epicBlock(issue) {
  const box = h('section', { class: 'block git-flow', id: 'git-flow' }, h('h3', null, icon('branch'), 'Git · epic branch'), h('div', { class: 'muted small' }, 'Reading the epic branch…'));
  getEpic(issue.key).then(
    (d) => fillEpic(box, issue, d),
    (e) => box.replaceChildren(box.firstChild, h('div', { class: 'error-box' }, e.message)),
  );
  return box;
}

function fillEpic(box, issue, d) {
  const repos = GIT_REPOS.filter((r) => d.repos[r]);
  // Ticket titles: the epic's children from Jira (most tickets on the branch aren't in my own list).
  if (!gitState.epicTitles.has(issue.key)) {
    gitState.epicTitles.set(issue.key, {});
    getDetail(issue.key)
      .then((det) => {
        gitState.epicTitles.set(issue.key, Object.fromEntries((det.children || []).map((c) => [c.key, c.summary])));
        if (box.isConnected) fillEpic(box, issue, d);
      })
      .catch(() => {});
  }
  gitState.titles = gitState.epicTitles.get(issue.key);
  const head = h(
    'h3',
    null,
    icon('branch'),
    'Git · epic branch',
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn sm', title: 'Reload', onClick: refreshGit }, icon('refresh')),
  );
  box.replaceChildren(head, ...repos.map((r) => epicCard(issue, d.repos[r], gitState.mrData[r])));
  for (const r of repos) if (d.repos[r].exists && (!gitState.mrData[r] || !gitState.mrs.has(r))) getMrs(r).then(() => box.isConnected && fillEpic(box, issue, d));
}

function epicCard(issue, e, M) {
  const repo = e.repo;
  const label = repo === 'backend' ? 'Backend' : 'Frontend';
  if (e.error) return h('div', { class: 'gsum' }, h('div', { class: 'gsum-top' }, h('b', null, label)), h('div', { class: 'error-box' }, e.error));
  if (!e.exists) {
    return h(
      'div',
      { class: 'gsum' },
      h('div', { class: 'gsum-top' }, h('b', null, label), code(e.name)),
      h('div', { class: 'gsum-headline' }, 'Not on origin'),
      h('div', { class: 'gsum-detail' }, 'Created from uat when the first task of this epic starts.'),
      h('div', { class: 'gstep-act' }, actBtn('Create epic from uat', () => gitAction({ action: 'ensure-epic', repo, epic: issue.key }, `Create ${e.name} from origin/uat and push it?`))),
    );
  }

  const tickets = epicTickets(e);
  const commits = tickets.flatMap((t) => t.commits);
  const onDev = commits.filter((c) => c.inDevelop || c.onDevBranch).length;
  const todo = tickets.filter((t) => t.missing.length);
  const noMr = tickets.filter((t) => t.direct).length;
  const filterKey = `epicFilter:${repo}`;
  const showAll = LS.get(filterKey, false) || !todo.length;
  const epicMr = mrsOf(M, e.name, 'uat').find((m) => m.state === 'opened') || mrsOf(M, e.name, 'uat')[0];

  const card = h('div', { class: `gsum ${todo.length || e.behindUat > 0 ? 't-warn' : 't-ok'}` });
  const redraw = () => card.replaceWith(epicCard(issue, e, M));
  card.append(
    h('div', { class: 'gsum-top' }, h('b', null, label), h('button', { class: 'gcode gbranch', title: `${e.name}\nClick to copy`, onClick: () => copyText(e.name, 'Branch name copied') }, e.name)),

    // uat side: the one epic → uat MR
    h(
      'div',
      { class: 'eline' },
      h('b', null, 'UAT'),
      h('span', null, e.pending ? `${e.pending} commit(s) waiting to go to uat` : 'everything is in uat', e.behindUat > 0 && gitChip(`${e.behindUat} behind uat`, 'warn'), epicMr && mrChip(epicMr), epicMr && mrFacts(epicMr)),
      h(
        'span',
        { class: 'gstep-act' },
        epicMr?.state === 'opened'
          ? linkBtn(epicMr.url, `Open MR !${epicMr.iid}`, false)
          : e.pending > 0 && (M?.byBranch ? linkBtn(mrUrl(e.web, e.name, 'uat', `${issue.key}: ${issue.summary}`, mrDescription(issue.key, e.name)), 'Create MR → uat', false) : linkBtn(mrListUrl(e.web, e.name), 'Epic MRs')),
        e.behindUat > 0 &&
          actBtn('Rebase onto uat', () =>
            gitAction({ action: 'rebase-epic', repo, epic: issue.key }, `Rebase ${e.name} onto origin/uat (keeping each task's merge commit) and FORCE-PUSH it?\n\nThe epic is shared: tell the team first. Open task branches will need a rebase afterwards.`),
            { danger: true },
          ),
      ),
    ),

    // develop side: progress, then one row per ticket
    commits.length
      ? h(
          'div',
          { class: 'eline' },
          h('b', null, 'Develop'),
          h(
            'span',
            null,
            `${onDev}/${commits.length} commits on develop`,
            todo.length ? gitChip(`${todo.length} ticket(s) to pick`, 'warn') : gitChip('all picked', 'ok'),
            h('span', { class: 'eprog' }, h('i', { style: `width:${Math.round((onDev / commits.length) * 100)}%` })),
          ),
        )
      : h('div', { class: 'muted small' }, 'No commits of its own yet.'),
    noMr > 0 && h('div', { class: 'gsum-detail warn-text' }, `⚠ ${noMr} ticket(s) were committed straight to the epic (no MR) — they can't be reverted with one merge commit.`),
    tickets.length > 0 &&
      h(
        'div',
        { class: 'etools' },
        h(
          'div',
          { class: 'gtabs' },
          h('button', { 'aria-selected': String(!showAll), disabled: !todo.length, onClick: () => (LS.set(filterKey, false), redraw()) }, `Needs pick (${todo.length})`),
          h('button', { 'aria-selected': String(showAll), onClick: () => (LS.set(filterKey, true), redraw()) }, `All tickets (${tickets.length})`),
        ),
      ),
    tickets.length > 0 && h('ul', { class: 'etickets' }, (showAll ? tickets : todo).map((t) => ticketRow(repo, t, redraw))),
  );
  return card;
}

// The epic's commits per ticket: which are on develop, which still need picking, and where they should go.
function epicTickets(e) {
  const map = new Map();
  for (const g of e.groups) {
    for (const c of g.commits) {
      const key = c.ticket || '(no ticket)';
      if (!map.has(key)) map.set(key, { key, commits: [], direct: false, merged: false, uatBranch: null });
      const t = map.get(key);
      t.commits.push(c);
      if (g.kind === 'merge') {
        t.merged = true;
        if (g.branch?.endsWith('-uat')) t.uatBranch ||= g.branch;
      } else t.direct = true;
    }
  }
  const tickets = [...map.values()];
  for (const t of tickets) {
    t.commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    t.missing = t.commits.filter((c) => !c.inDevelop && !c.onDevBranch);
    const b = e.branches?.[t.key] || {};
    t.target = b.develop || (t.uatBranch || b.uat || '').replace(/-uat$/, '-develop') || '';
    t.latest = Math.max(...t.commits.map((c) => Date.parse(c.date)));
  }
  return tickets.sort((a, b) => (b.missing.length > 0) - (a.missing.length > 0) || b.latest - a.latest);
}

function ticketRow(repo, t, redraw) {
  const open = gitState.epicOpen.has(`${repo}:${t.key}`);
  const toggle = () => {
    open ? gitState.epicOpen.delete(`${repo}:${t.key}`) : gitState.epicOpen.add(`${repo}:${t.key}`);
    redraw();
  };
  const summary = state.issues.find((i) => i.key === t.key)?.summary || gitState.titles?.[t.key] || '';
  const picked = t.commits.length - t.missing.length;
  const boxes = t.missing.map((c) => h('input', { type: 'checkbox', checked: true, value: c.sha, 'aria-label': c.subject }));

  const pick = async () => {
    const shas = open ? boxes.filter((b) => b.checked).map((b) => b.value) : t.missing.map((c) => c.sha);
    if (!shas.length) return toast('No commit selected', 'error');
    let target = t.target;
    if (!target) {
      target = await promptPop(`Cherry-pick ${t.key} to develop`, {
        value: `feature/${t.key}-`,
        hint: 'No task branch known for this ticket. Name the -develop branch to create (from develop).',
        okLabel: 'Use branch',
        validate: (x) => (/^(feature|bugfix|refactor|chore|docs|test)\/VLEARN-\d+-[a-z0-9._-]+-develop$/.test(x.trim()) ? '' : 'Expected feature/VLEARN-123-description-develop'),
      });
      if (target == null) return;
      target = t.target = target.trim();
    }
    const list = t.missing.filter((c) => shas.includes(c.sha));
    gitAction({ action: 'pick-develop', repo, branch: target, shas }, `Cherry-pick ${list.length} commit(s) of ${t.key} onto ${target} and push it:\n\n${list.map((c) => `${c.short} ${c.subject.replace(/^VLEARN-\d+: /, '')}`).join('\n')}`);
  };
  const changeTarget = async () => {
    const v = await promptPop(`Develop branch for ${t.key}`, {
      value: t.target || `feature/${t.key}-`,
      okLabel: 'Use branch',
      validate: (x) => (/^(feature|bugfix|refactor|chore|docs|test)\/VLEARN-\d+-[a-z0-9._-]+-develop$/.test(x.trim()) ? '' : 'Expected feature/VLEARN-123-description-develop'),
    });
    if (v != null) (t.target = v.trim()), redraw();
  };

  const mark = (c) => (c.inDevelop ? h('span', { class: 'emark ok', title: 'In develop' }, '✓') : c.onDevBranch ? h('span', { class: 'emark picked', title: 'Picked onto the -develop branch, not merged yet' }, '●') : h('span', { class: 'emark todo', title: 'Not on develop yet' }, '○'));
  const done = t.commits.filter((c) => !t.missing.includes(c));

  return h(
    'li',
    { class: `eticket${open ? ' open' : ''}${t.missing.length ? '' : ' complete'}` },
    h(
      'div',
      { class: 'eticket-head', onClick: (ev) => !ev.target.closest('a,button') && toggle() },
      h('span', { class: 'fold-icon' }, icon('chevRight')),
      t.key.startsWith('VLEARN') ? h('a', { class: 'key', href: '#' + t.key, onClick: (ev) => (ev.preventDefault(), openDetail(t.key)) }, t.key) : h('span', { class: 'muted' }, t.key),
      h('span', { class: 'gsubj muted', title: summary }, summary),
      t.direct && gitChip('no MR', 'warn', 'Committed straight to the epic'),
      h('span', { class: `small ${t.missing.length ? '' : 'ok-text'}` }, `${picked}/${t.commits.length}`),
      t.missing.length > 0 ? actBtn(`Pick ${t.missing.length}`, pick, { primary: true, title: t.target ? `→ ${t.target}` : 'Choose the -develop branch' }) : h('span', { class: 'emark ok' }, '✓'),
    ),
    open &&
      h(
        'div',
        { class: 'eticket-body' },
        t.missing.length > 0 &&
          h('div', { class: 'etarget' }, '→ ', t.target ? code(t.target) : h('span', { class: 'muted' }, 'no -develop branch yet'), h('button', { class: 'link-btn', onClick: changeTarget }, t.target ? 'change' : 'choose')),
        t.missing.length > 0 &&
          h('ul', { class: 'ecommits' }, t.missing.map((c, i) => h('li', { class: 'ecommit' }, h('label', null, boxes[i], mark(c), h('span', { class: 'mono muted' }, c.short), h('span', { class: 'gsubj', title: c.subject }, c.subject.replace(/^VLEARN-\d+: /, ''))), h('span', { class: 'muted small', title: `${c.author} · ${fmtDate(c.date)}` }, rel(c.date))))),
        done.length > 0 &&
          h(
            'details',
            { class: 'edone', open: !t.missing.length },
            h('summary', null, `${done.length} already on develop`),
            h('ul', { class: 'ecommits' }, done.map((c) => h('li', { class: 'ecommit' }, h('span', { class: 'elabel' }, mark(c), h('span', { class: 'mono muted' }, c.short), h('span', { class: 'gsubj muted', title: c.subject }, c.subject.replace(/^VLEARN-\d+: /, ''))), h('span', { class: 'muted small' }, rel(c.date))))),
          ),
      ),
  );
}

// Nothing in git yet: one button that does the whole setup the rule asks for.
function startPanel(issue, f) {
  const epicReady = GIT_REPOS.some((r) => f.repos[r]?.epic?.remote);
  return h(
    'div',
    { class: 'gsum gsum-start' },
    h('div', { class: 'gsum-headline' }, 'Not started in git yet'),
    h(
      'ol',
      { class: 'gsum-plan' },
      h('li', null, epicReady ? ['Use ', code(`epic/${f.epic}`)] : ['Create ', code(`epic/${f.epic}`), ' from uat']),
      h('li', null, 'Create ', code(`feature/${issue.key}-<short-description>-uat`), ' from the epic'),
      h('li', null, 'Stash your unfinished work and check the new branch out'),
    ),
    h('div', { class: 'gstep-act' }, actBtn('Start…', () => startTaskPop(issue), { primary: true, iconName: 'branch' })),
  );
}

// Plain-language state of one repo: a headline, 4 milestones and the next action(s).
function repoStatus(issue, f, r, M) {
  const key = issue.key;
  const repo = r.repo;
  const epic = r.epic;
  const uat = r.uat;
  const dev = r.develop;
  const commits = r.commits || [];
  const title = commits[0]?.subject || `${key}: ${issue.summary}`;
  const devName = dev?.name || (uat ? uat.name.replace(/-uat$/, '-develop') : `feature/${key}-${slugify(issue.summary)}-develop`);
  const desc = mrDescription(key, epic.name, devName);
  const mrs = (src, tgt) => (src ? mrsOf(M, src, tgt) : []);
  const openMr = (src, tgt) => mrs(src, tgt).find((m) => m.state === 'opened');
  const mergedMr = (src, tgt) => mrs(src, tgt).find((m) => m.state === 'merged');
  const newMr = (src, tgt, label, primary = true) => linkBtn(mrUrl(r.web, src, tgt, title, desc), label, primary);
  const openBtn = (m, primary = true) => linkBtn(m.url, `Open MR !${m.iid}`, primary);
  const push = (b, primary = true) =>
    b.sync?.onlyB > 0
      ? actBtn('Force-push', () => gitAction({ action: 'push', repo, branch: b.name, force: true }, `${b.name} on origin differs from local (after a rebase / undo).\n\nForce-push with lease, replacing origin's version?`), { danger: true, iconName: 'upload' })
      : actBtn('Push', () => gitAction({ action: 'push', repo, branch: b.name }), { primary, iconName: 'upload' });

  const pushed = !!uat?.remote && !(uat.sync?.onlyA > 0);
  const inEpic = !!uat?.mergedToEpic || !!mergedMr(uat?.name, epic.name) || uat?.onEpicWithoutMerge > 0;
  const inUat = commits.length > 0 && commits.every((c) => c.inUat);
  const inDev = (commits.length > 0 && commits.every((c) => c.inDevelop)) || !!mergedMr(dev?.name, 'develop');
  const missing = commits.filter((c) => !c.picked);
  const milestones = [
    { label: 'Code', done: pushed && commits.length > 0 },
    { label: 'Epic', done: inEpic, warn: uat?.onEpicWithoutMerge > 0 && !uat?.mergedToEpic },
    { label: 'UAT', done: inUat },
    { label: 'Develop', done: inDev },
  ];

  const out = { milestones, tone: 'accent', lines: [], actions: [] };
  const dirtyHere = uat && r.current === uat.name && r.dirty > 0;

  if (!uat) {
    out.headline = commits.length ? `${commits.length} ${key} commit(s), but no ${key} -uat branch` : 'No task branch';
    out.detail = commits.length ? 'Commits went straight to another branch (not the flow: task branch → MR → epic).' : '';
    out.tone = 'warn';
    out.actions.push(actBtn('Start…', () => startTaskPop(issue, { repos: [repo] }), { primary: true, iconName: 'branch' }));
    return out;
  }
  if (dirtyHere) {
    out.headline = `Coding — ${r.dirty} uncommitted file(s)`;
    out.detail = `Commit as "${key}: <what changed, in English>".`;
    out.actions.push(actBtn('Commit…', () => openCommitDialog(repo), { primary: true }));
  } else if (!commits.length) {
    out.headline = 'Branch ready — no commits yet';
    out.detail = uat.name === r.current ? 'Checked out: start coding.' : 'Check it out to start coding.';
    if (uat.name !== r.current && !uat.worktree) out.actions.push(actBtn('Checkout', () => gitAction({ action: 'checkout', repo, branch: uat.name }), { primary: true }));
  } else if (!uat.remote || uat.sync?.onlyA > 0) {
    out.headline = !uat.remote ? 'Not pushed yet' : `${uat.sync.onlyA} commit(s) not pushed`;
    out.detail = 'Push, then open the MR into the epic.';
    out.tone = 'warn';
    out.actions.push(push(uat));
  } else if (!inEpic && openMr(uat.name, epic.name)?.conflicts) {
    const m = openMr(uat.name, epic.name);
    out.headline = `MR !${m.iid} has conflicts with the epic`;
    out.detail = 'Rebase onto the epic, resolve the conflicts, then it force-pushes (a backup is kept).';
    out.tone = 'warn';
    out.mr = m;
    out.actions.push(
      actBtn('Rebase & push', () => gitAction({ action: 'sync-task', repo, epic: f.epic, branch: uat.name }, `Rebase ${uat.name} onto origin/${epic.name} and force-push it (with lease)?`), { primary: true }),
      openBtn(m, false),
    );
  } else if (!inEpic && uat.behindEpic > 0) {
    out.headline = 'Epic moved on — rebase before the MR';
    out.detail = `${uat.behindEpic} new commit(s) on ${epic.name}. Rebasing keeps the MR clean (a backup is kept).`;
    out.tone = 'warn';
    out.actions.push(
      actBtn('Rebase & push', () => gitAction({ action: 'sync-task', repo, epic: f.epic, branch: uat.name }, `Rebase ${uat.name} onto origin/${epic.name} and force-push it (with lease)?`), { primary: true }),
    );
    const m = openMr(uat.name, epic.name);
    if (m) out.actions.push(openBtn(m, false));
    out.mr = m;
  } else if (!inEpic) {
    const m = openMr(uat.name, epic.name);
    out.mr = m;
    out.headline = !m ? 'Ready for the MR into the epic' : !m.resolved ? `MR !${m.iid} has unresolved review threads` : m.comments ? `MR !${m.iid} in review` : `MR !${m.iid} waiting for review`;
    out.detail = m ? `${uat.name} → ${epic.name}` : `Merge it with “Create merge commit” (one merge commit per task).`;
    if (m && !m.resolved) out.tone = 'warn';
    out.actions.push(m ? openBtn(m) : newMr(uat.name, epic.name, 'Create MR → epic'));
    if (!M?.byBranch && !m) out.actions.push(linkBtn(mrListUrl(r.web, uat.name), 'MRs'));
  } else {
    // In the epic: two independent tracks left, uat (via the epic MR) and develop (cherry-pick + MR).
    // A task MR can still be open when its commits reached the epic another way — it still needs attention.
    const taskMr = openMr(uat.name, epic.name);
    if (taskMr) out.lines.push({ label: 'Epic', mr: taskMr, text: `task MR !${taskMr.iid} still open`, actions: [openBtn(taskMr, false)] });
    out.headline = inUat && inDev ? 'Done — in uat and develop' : uat.onEpicWithoutMerge && !uat.mergedToEpic ? 'On the epic (without a merge commit)' : 'Merged into the epic';
    out.tone = inUat && inDev ? 'ok' : uat.onEpicWithoutMerge && !uat.mergedToEpic ? 'warn' : 'ok';

    if (inUat) out.lines.push({ label: 'UAT', ok: true, text: 'in uat' });
    else {
      const m = openMr(epic.name, 'uat');
      out.lines.push({
        label: 'UAT',
        mr: m,
        text: m ? `${m.conflicts ? 'epic MR' : 'waiting for the epic MR'} !${m.iid}${m.draft ? ' (draft)' : ''}` : epic.pending > 0 ? 'needs the one epic → uat MR' : 'waiting for the epic to reach uat',
        actions: m ? [openBtn(m, false)] : epic.pending > 0 ? [M?.byBranch ? newMr(epic.name, 'uat', 'Create epic MR → uat', false) : linkBtn(mrListUrl(r.web, epic.name), 'Epic MRs')] : [],
      });
    }

    if (inDev) out.lines.push({ label: 'Develop', ok: true, text: 'in develop' });
    else if (missing.length) {
      out.lines.push({
        label: 'Develop',
        text: `${missing.length} of ${commits.length} commit(s) to cherry-pick onto ${devName}`,
        actions: [
          actBtn(`Cherry-pick ${missing.length} → develop`, () =>
            gitAction(
              { action: 'pick-develop', repo, branch: devName, shas: missing.map((c) => c.sha) },
              `Cherry-pick onto ${devName}${dev ? '' : ' (created from develop)'} and push it:\n\n${missing.map((c) => `${c.short} ${c.subject}`).join('\n')}`,
            ),
          ),
        ],
      });
    } else if (dev && (!dev.remote || dev.sync?.onlyA > 0)) {
      out.lines.push({ label: 'Develop', text: 'picked, not pushed', actions: [push(dev, false)] });
    } else {
      const m = dev && openMr(dev.name, 'develop');
      out.lines.push({
        label: 'Develop',
        mr: m,
        text: m ? `MR !${m.iid}${m.conflicts ? '' : ' waiting for review'}` : 'picked — needs the MR → develop (same title as uat)',
        actions: [m ? openBtn(m, false) : dev ? newMr(dev.name, 'develop', 'Create MR → develop', false) : null],
      });
    }
  }
  return out;
}

function repoCard2(issue, f, r, M, missingRepos) {
  const repo = r.repo;
  const label = repo === 'backend' ? 'Backend' : 'Frontend';
  if (r.error) return h('div', { class: 'gsum' }, h('div', { class: 'gsum-top' }, h('b', null, label)), h('div', { class: 'error-box' }, r.error));
  const st = repoStatus(issue, f, r, M);
  const branch = r.uat?.name || r.develop?.name;
  const checks = flowChecks(issue.key, r, M);
  const openAll = LS.get('gitAllSteps', false);

  return h(
    'div',
    { class: `gsum t-${st.tone}` },
    h(
      'div',
      { class: 'gsum-top' },
      h('b', null, label),
      branch && h('button', { class: 'gcode gbranch', title: `${branch}\nClick to copy`, onClick: () => copyText(branch, 'Branch name copied') }, branch),
      branch && branch === r.current && gitChip('checked out', 'accent'),
    ),
    (r.conflicts || []).map((c) =>
      h('div', { class: 'gconflict' }, h('div', null, h('b', null, `${c.op} stopped on a conflict`), ' in ', code(c.dir)), h('div', { class: 'gstep-act' }, conflictActions(repo, c.dir, c.op))),
    ),
    h('div', { class: 'gsum-headline' }, st.headline),
    st.detail && h('div', { class: 'gsum-detail' }, st.detail),
    st.mr && mrFacts(st.mr).length > 0 && h('div', { class: 'gstep-note' }, mrFacts(st.mr)),
    h(
      'ol',
      { class: 'gtrack' },
      st.milestones.map((m) => h('li', { class: m.done ? (m.warn ? 'warn' : 'done') : '' }, h('span', { class: 'gtrack-dot' }, m.done ? icon('check') : ''), m.label)),
    ),
    st.lines.length > 0 &&
      h(
        'ul',
        { class: 'gsum-lines' },
        st.lines.map((l) => h('li', { class: l.ok ? 'ok' : '' }, h('b', null, l.label), h('span', { class: 'gline-text' }, l.ok ? '✓ ' + l.text : l.text, mrFacts(l.mr)), l.actions?.length > 0 && h('span', { class: 'gstep-act' }, l.actions))),
      ),
    st.actions.length > 0 && h('div', { class: 'gstep-act' }, st.actions),
    checks.length > 0 &&
      h('details', { class: 'gsum-checks' }, h('summary', null, `⚠ ${checks.length} flow warning${checks.length > 1 ? 's' : ''}`), h('ul', null, checks.map((c) => h('li', null, c)))),
    h(
      'details',
      { class: 'gsum-all', open: openAll, onToggle: (e) => LS.set('gitAllSteps', e.target.open) },
      h('summary', null, 'All steps'),
      flowSteps(issue, f, r, M),
    ),
    missingRepos.length > 0 &&
      r.uat &&
      h(
        'div',
        { class: 'gsum-more' },
        missingRepos.map((x) =>
          h('button', { class: 'link-btn', onClick: () => startTaskPop(issue, { repos: [x], preset: r.uat.name }) }, `+ Start in ${x === 'backend' ? 'Backend' : 'Frontend'} (same branch name)`),
        ),
      ),
  );
}

// Rule checks (lms/.cursor/rules/git-workflow.mdc).
function flowChecks(key, r, M) {
  const checks = [];
  const { uat, epic } = r;
  const foreign = (b, where) =>
    b?.foreign?.length > 0 &&
    checks.push([
      `${b.foreign.length} commit(s) on `,
      code(b.name),
      ` aren't ${key} — branched off the wrong base (${where}) or wrong commit message: `,
      b.foreign.slice(0, 3).map((c) => code(`${c.sha} ${c.subject}`)),
    ]);
  foreign(uat, 'should be the epic');
  foreign(r.develop, 'should be develop');
  if (uat && mrsOf(M, uat.name, 'uat').length) checks.push(['MR from the task branch straight into ', code('uat'), ' — it must go into the epic.']);
  if (mrsOf(M, epic.name, 'uat').filter((m) => m.state === 'opened').length > 1) checks.push(['More than one open MR ', code(`${epic.name} → uat`), ' — keep exactly one.']);
  if (uat && mrsOf(M, uat.name).some((m) => m.target.startsWith('epic/') && m.target !== epic.name)) checks.push(['The task MR targets a different epic than ', code(epic.name), '.']);
  if (uat?.onEpicWithoutMerge && !uat.mergedToEpic) checks.push(['Commits reached the epic without a merge commit — this task cannot be reverted with one ', code('git revert -m 1'), '.']);
  return checks;
}

function flowSteps(issue, f, r, M) {
  const key = issue.key;
  const repo = r.repo;
  const epic = r.epic;
  const uat = r.uat;
  const commits = r.commits || [];
  const title = commits[0]?.subject || `${key}: ${issue.summary}`;
  const devName = r.develop?.name || (uat ? uat.name.replace(/-uat$/, '-develop') : null);
  const desc = mrDescription(key, epic.name, devName);
  const steps = [];
  const step = (status, name, body, actions) =>
    steps.push(
      h(
        'li',
        { class: `gstep s-${status}` },
        h('span', { class: 'gstep-dot' }, status === 'done' ? icon('check') : ''),
        h('div', { class: 'gstep-body' }, h('div', { class: 'gstep-name' }, name), body),
        actions && h('div', { class: 'gstep-act' }, actions),
      ),
    );
  const note = (...kids) => h('div', { class: 'gstep-note' }, ...kids);
  const undo = (b) =>
    b?.backups?.length > 0 &&
    actBtn('Undo', () => gitAction({ action: 'undo', repo, branch: b.name }, `Reset ${b.name} to its backup from ${fmtDate(b.backups[0].at)}?`), {
      iconName: 'undo',
      title: `Back to ${b.backups[0].sha} (backed up ${rel(b.backups[0].at)})`,
    });
  // Push, or force-push with lease once local and origin diverged (after a rebase or an undo).
  const pushBtn = (b, primary) => {
    if (!b || (b.remote && !(b.sync?.onlyA > 0))) return null;
    if (b.sync?.onlyB > 0) {
      return actBtn('Force-push', () => gitAction({ action: 'push', repo, branch: b.name, force: true }, `${b.name} on origin differs from local (after a rebase / undo).\n\nForce-push with lease, replacing origin's version?`), {
        danger: true,
        iconName: 'upload',
      });
    }
    return actBtn('Push', () => gitAction({ action: 'push', repo, branch: b.name }), { primary, iconName: 'upload' });
  };
  const where = (b) => [
    ...mrsOf(M, b.name).slice(0, 2).map(mrChip),
    b.local ? gitChip('local') : null,
    b.remote ? gitChip('origin', 'ok') : gitChip('not pushed', 'warn'),
    b.name === r.current ? gitChip('checked out', 'accent') : b.worktree ? gitChip('worktree', '', b.worktree) : null,
  ];

  // An open MR for source → target is the thing to go to; otherwise offer to create one.
  const mrButtons = (source, target, primary) => {
    const list = mrsOf(M, source, target);
    const open = list.find((m) => m.state === 'opened');
    if (open) return [linkBtn(open.url, `Open !${open.iid}`, primary)];
    return [linkBtn(mrUrl(r.web, source, target, title, desc), `New MR → ${target === epic.name ? 'epic' : target}`, primary), linkBtn(mrListUrl(r.web, source), 'MRs')];
  };
  const mrNote = (source, target) => mrsOf(M, source, target).slice(0, 3).map(mrChip);

  // 1. Epic
  if (!epic.remote) {
    step('todo', ['Epic ', code(epic.name)], note('Not on origin yet. Created off ', code('uat'), ', one per Jira Epic.'), [
      actBtn('Create epic', () => gitAction({ action: 'ensure-epic', repo, epic: f.epic }, `Create ${epic.name} from origin/uat and push it?`), { primary: true }),
    ]);
  } else {
    const behind = epic.behindUat > 0;
    step(
      behind ? 'warn' : 'done',
      ['Epic ', code(epic.name)],
      note(
        gitChip(`${epic.pending} commit${epic.pending === 1 ? '' : 's'} not in uat`, epic.pending ? '' : 'ok'),
        behind && gitChip(`${epic.behindUat} behind uat`, 'warn', 'Rebase the epic onto uat (--rebase-merges) when it has conflicts with uat'),
        epic.mergedToUat && gitChip(`merged to uat ${epic.mergedToUat.sha}`, 'ok', epic.mergedToUat.subject),
      ),
      [
        behind &&
          actBtn('Rebase epic onto uat', () =>
            gitAction(
              { action: 'rebase-epic', repo, epic: f.epic },
              `Rebase ${epic.name} onto origin/uat (keeping each task's merge commit) and FORCE-PUSH it?\n\nThe epic is shared: tell the team first. Open task branches will need a rebase afterwards.`,
            ),
            { danger: true },
          ),
        undo(epic),
      ],
    );
  }

  // 2. Task branch
  if (uat) {
    step(
      'done',
      ['Task branch ', code(uat.name)],
      note(where(uat), uat.others?.length > 0 && gitChip(`+${uat.others.length} other`, '', uat.others.join('\n'))),
      uat.name !== r.current &&
        !uat.worktree &&
        actBtn('Checkout', () => gitAction({ action: 'checkout', repo, branch: uat.name }), { title: `Switch ${r.dir} to this branch` }),
    );
  } else {
    step(
      'todo',
      'Start a branch',
      note('No ', code(`-uat`), ` branch for ${key} yet. Created off `, code(epic.name), epic.remote ? '' : ' (made from uat first)', ', then checked out.'),
      actBtn('Start…', () => startTaskPop(issue, { repos: [repo] }), { primary: true, iconName: 'branch' }),
    );
  }

  if (uat) {
    // 3. Commit, keep up with the epic, push
    const s = uat.sync;
    const toPush = !uat.remote || s?.onlyA > 0;
    const behindEpic = uat.behindEpic > 0 && !uat.mergedToEpic; // once merged the epic moves on without it
    const dirtyHere = uat.name === r.current && r.dirty > 0;
    step(
      dirtyHere || toPush || behindEpic ? 'todo' : 'done',
      'Commit · rebase onto epic · push',
      note(
        dirtyHere && gitChip(`${r.dirty} uncommitted`, 'warn'),
        commits.length > 0 && gitChip(`${commits.length} ${key} commit${commits.length > 1 ? 's' : ''}`),
        !uat.remote ? gitChip('not pushed', 'warn') : s?.onlyA > 0 && gitChip(`${s.onlyA} to push`, 'warn'),
        s?.onlyB > 0 && gitChip(`${s.onlyB} only on origin`, 'warn', 'Local and origin diverged'),
        behindEpic && gitChip(`${uat.behindEpic} behind epic`, 'warn'),
        !dirtyHere && !toPush && !behindEpic && gitChip('up to date with epic & origin', 'ok'),
      ),
      [
        dirtyHere && actBtn('Commit…', () => openCommitDialog(repo), { primary: true }),
        behindEpic
          ? actBtn(uat.remote ? 'Rebase & force-push' : 'Rebase & push', () =>
              gitAction({ action: 'sync-task', repo, epic: f.epic, branch: uat.name }, `Rebase ${uat.name} onto origin/${epic.name} and ${uat.remote ? 'force-push (with lease)' : 'push'}?`),
              { primary: !dirtyHere },
            )
          : toPush && pushBtn(uat, !dirtyHere),
        undo(uat),
      ],
    );

    // 4. MR task → epic
    if (uat.mergedToEpic) {
      step('done', 'MR task → epic', note(mrNote(uat.name, epic.name), gitChip(`merged ${uat.mergedToEpic.sha}`, 'ok', uat.mergedToEpic.subject), ' ', rel(uat.mergedToEpic.at)), linkBtn(mrListUrl(r.web, uat.name), 'MRs'));
    } else {
      const skipped = uat.onEpicWithoutMerge > 0;
      step(
        skipped ? 'warn' : 'todo',
        'MR task → epic',
        note(
          mrNote(uat.name, epic.name),
          skipped
            ? [gitChip(`${uat.onEpicWithoutMerge} commit(s) already on the epic without a merge commit`, 'warn'), ' — this task cannot be reverted with one ', code('git revert -m 1'), '.']
            : uat.remote
              ? 'Merge with “Create merge commit” (1 merge commit per task). Never merge locally into the epic.'
              : 'Push the branch first.',
        ),
        uat.remote && mrButtons(uat.name, epic.name, !skipped && uat.aheadEpic > 0),
      );
    }
  }

  // 5. MR epic → uat (exactly one per epic per repo)
  if (epic.remote) {
    const done = epic.mergedToUat && !epic.pending;
    step(
      done ? 'done' : epic.pending ? 'todo' : 'na',
      'MR epic → uat',
      note(
        mrNote(epic.name, 'uat'),
        done ? gitChip('everything on the epic is in uat', 'ok') : 'Only ONE MR per epic per repo; tasks merged into the epic later show up in it.',
      ),
      !done &&
        (M?.byBranch
          ? mrButtons(epic.name, 'uat', epic.pending > 0)
          : [linkBtn(mrListUrl(r.web, epic.name), 'Existing MR', epic.pending > 0), linkBtn(mrUrl(r.web, epic.name, 'uat', title, desc), 'New MR → uat')]),
    );
  }

  // 6. Cherry-pick to develop
  const missing = commits.filter((c) => !c.picked);
  const dev = r.develop;
  if (!commits.length) {
    step('na', 'Cherry-pick to develop', note(`No commits starting with ${key}: yet.`));
  } else if (!missing.length) {
    step(
      'done',
      ['Develop branch ', dev ? code(dev.name) : ''],
      note(dev && where(dev), gitChip(`all ${commits.length} commit${commits.length > 1 ? 's' : ''} picked`, 'ok')),
      [pushBtn(dev, true), undo(dev)],
    );
  } else {
    const boxes = missing.map((c) => h('input', { type: 'checkbox', checked: true, value: c.sha }));
    const target = h('input', { class: 'gin mono', value: devName || `feature/${key}-${slugify(issue.summary)}-develop`, spellcheck: 'false', 'aria-label': 'Develop branch' });
    step(
      'todo',
      'Cherry-pick to develop',
      h(
        'div',
        null,
        note(`${missing.length} of ${commits.length} commits not on develop yet (oldest first, merge commits excluded):`),
        h('ul', { class: 'gcommits' }, missing.map((c, i) => h('li', null, h('label', null, boxes[i], h('span', { class: 'mono muted' }, c.short), h('span', { class: 'gsubj', title: c.subject }, c.subject))))),
        dev ? note('Into ', where(dev)) : note('Creates the branch off ', code('origin/develop'), ':'),
        target,
      ),
      [
        pushBtn(dev, false),
        actBtn(
          `Cherry-pick → develop`,
          () => {
            const shas = boxes.filter((b) => b.checked).map((b) => b.value);
            if (!shas.length) return toast('No commit selected', 'error');
            gitAction({ action: 'pick-develop', repo, branch: target.value.trim(), shas }, `Cherry-pick ${shas.length} commit(s) onto ${target.value.trim()} and push it?`);
          },
          { primary: true },
        ),
        undo(dev),
      ],
    );
  }

  // 7. MR → develop (same title + description as the uat one)
  if (commits.length) {
    const inDevelop = commits.every((c) => c.inDevelop) || (dev && mrsOf(M, dev.name, 'develop').some((m) => m.state === 'merged'));
    step(
      inDevelop ? 'done' : dev?.remote ? 'todo' : 'na',
      'MR → develop',
      note(
        dev && mrNote(dev.name, 'develop'),
        inDevelop ? gitChip('all commits are in develop', 'ok') : dev?.remote ? 'Title and description identical to the uat MR.' : 'Push the develop branch first.',
      ),
      !inDevelop && dev?.remote && mrButtons(dev.name, 'develop', true),
    );
  }

  return h(
    'div',
    null,
    h('ol', { class: 'gsteps' }, steps),
    h(
      'div',
      { class: 'muted small gfoot' },
      r.fetchedAt ? `Remote state from fetch ${rel(new Date(r.fetchedAt).toISOString())} · ` : '',
      h('button', { class: 'link-btn', onClick: () => gitAction({ action: 'fetch', repo }) }, 'Fetch now'),
      ' · ',
      !M ? 'loading MR status…' : M.error ? h('span', { class: 'warn-text', title: M.error }, `MR status unavailable: ${M.error}`) : 'MR status from GitLab',
    ),
  );
}

// ---------------------------------------------------------------------------
// Popconfirm / prompt (instead of the browser's confirm() and prompt())

// The button that was just pressed, so a popover can point at it.
let popAnchor = null;
document.addEventListener('pointerdown', (e) => (popAnchor = e.target.closest?.('button, a') || null), true);
document.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (popAnchor = document.activeElement), true);

// Anchored popover next to the pressed button; long content (or no anchor) becomes a centred modal.
// Resolves with the value from onOk, or null when dismissed (Esc, Cancel, click outside).
function popover({ title, body, okLabel = 'Confirm', danger = false, long = false, onOk, focus }) {
  const anchor = popAnchor && popAnchor.isConnected ? popAnchor : null;
  const centred = long || !anchor;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      wrap.remove();
      removeEventListener('keydown', onKey, true);
      removeEventListener('pointerdown', onOutside, true);
      removeEventListener('scroll', onScroll, true);
      anchor?.focus?.();
      resolve(value);
    };
    const ok = () => {
      const value = onOk ? onOk() : true;
      if (value !== undefined) finish(value);
    };
    const cancelBtn = h('button', { class: 'btn sm', onClick: () => finish(null) }, 'Cancel');
    const okBtn = h('button', { class: `btn sm ${danger ? 'danger solid' : 'primary'}`, onClick: ok }, okLabel);
    const box = h(
      'div',
      { class: `gpop${centred ? ' centred' : ''}${danger ? ' is-danger' : ''}`, role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'gpop-title' }, h('span', { class: 'gpop-icon' }, danger ? '!' : '?'), title),
      body && h('div', { class: 'gpop-body' }, body),
      h('div', { class: 'gpop-actions' }, cancelBtn, okBtn),
    );
    const wrap = centred ? h('div', { class: 'gmodal', onClick: (e) => e.target === wrap && finish(null) }, box) : box;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target !== cancelBtn) {
        e.stopImmediatePropagation();
        e.preventDefault();
        ok();
      }
    };
    const onOutside = (e) => !centred && !box.contains(e.target) && finish(null);
    // Follow the button when the drawer / page scrolls.
    const onScroll = () => {
      if (!anchor.isConnected) return finish(null);
      box.classList.remove('below', 'above');
      placePop(box, anchor);
    };
    document.body.append(wrap);
    if (!centred) {
      placePop(box, anchor);
      addEventListener('scroll', onScroll, true);
    }
    addEventListener('keydown', onKey, true);
    setTimeout(() => addEventListener('pointerdown', onOutside, true));
    (focus?.() || (danger ? cancelBtn : okBtn)).focus();
  });
}

function placePop(box, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth;
  const hgt = box.offsetHeight;
  const below = r.bottom + 10 + hgt <= innerHeight || r.top - 10 - hgt < 0;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
  box.style.left = left + 'px';
  box.style.top = (below ? r.bottom + 10 : r.top - 10 - hgt) + 'px';
  box.classList.add(below ? 'below' : 'above');
  box.style.setProperty('--arrow-x', Math.max(14, Math.min(r.left + r.width / 2 - left, w - 14)) + 'px');
}

// Paragraphs split on blank lines; a paragraph of several lines (e.g. branch names) renders as a list.
function confirmPop(text, { title = 'Continue?', okLabel = 'Confirm', danger = false } = {}) {
  const paras = String(text).split(/\n\s*\n/);
  const body = paras.map((p) => {
    const lines = p.split('\n');
    return lines.length > 1 ? h('ul', { class: 'gpop-list' }, lines.map((l) => h('li', { class: 'mono' }, l))) : h('p', null, p);
  });
  return popover({ title, body, okLabel, danger, long: String(text).split('\n').length > 8 || String(text).length > 360 }).then((v) => v === true);
}

function promptPop(title, { value = '', prefix, hint, okLabel = 'OK', validate } = {}) {
  const input = h('input', { class: 'gin mono', value, spellcheck: 'false', autocomplete: 'off' });
  const err = h('div', { class: 'gpop-err', hidden: true });
  input.addEventListener('input', () => (err.hidden = true));
  return popover({
    title,
    okLabel,
    body: [h('div', { class: 'gform-row' }, prefix && h('span', { class: 'mono muted gfix' }, prefix), input), err, hint && h('div', { class: 'muted small' }, hint)],
    focus: () => (setTimeout(() => input.select()), input),
    onOk: () => {
      const problem = validate?.(input.value) || '';
      if (!problem) return input.value;
      err.textContent = problem;
      err.hidden = false;
      input.focus();
      return undefined; // keep open
    },
  });
}

// ---------------------------------------------------------------------------
// Dialogs

function modal(titleText, body, { onClose } = {}) {
  const close = () => {
    el.remove();
    removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    }
  };
  const el = h(
    'div',
    { class: 'gmodal', onClick: (e) => e.target === el && close() },
    h(
      'div',
      { class: 'gmodal-box', role: 'dialog', 'aria-label': titleText },
      h('div', { class: 'gmodal-head' }, h('h2', null, titleText), h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: 'Close (Esc)', onClick: close }, icon('x'))),
      body,
    ),
  );
  addEventListener('keydown', onKey, true);
  document.body.append(el);
  return { el, close };
}

async function openCommitDialog(repo) {
  let main;
  try {
    main = (await api('/api/git/overview')).repos[repo].main;
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (!main.files.length) return toast('Nothing to commit', 'error');
  const ticket = ticketOf(main.branch);
  const boxes = main.files.map((f) => h('input', { type: 'checkbox', checked: true, value: f.path }));
  const msg = h('textarea', { class: 'gin mono', rows: '3', spellcheck: 'true', placeholder: `${ticket || 'VLEARN-XXXX'}: <what changed, in English>` });
  msg.value = ticket ? `${ticket}: ` : '';
  const XY = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'untracked', U: 'conflict' };
  const status = (xy) => (xy === '??' ? '?' : xy[1] !== '.' ? xy[1] : xy[0]);
  const all = h('input', { type: 'checkbox', checked: true, onChange: (e) => boxes.forEach((b) => (b.checked = e.target.checked)) });
  const submit = () => {
    const files = boxes.filter((b) => b.checked).map((b) => b.value);
    if (!files.length) return toast('No file selected', 'error');
    dlg.close();
    gitAction({ action: 'commit', repo, message: msg.value, files });
  };
  const dlg = modal(
    `Commit · ${repo}`,
    h(
      'div',
      { class: 'gmodal-body' },
      h('div', { class: 'muted small' }, 'On ', code(main.branch || '(detached)'), ` · ${main.files.length} changed file(s). Hooks run on commit (lint-staged, typecheck, gitleaks…) — may take minutes.`),
      h('label', { class: 'gcheck-all' }, all, 'All files'),
      h(
        'ul',
        { class: 'gfiles' },
        main.files.map((f, i) => {
          const s = status(f.xy);
          return h('li', null, h('label', null, boxes[i], h('span', { class: `gxy x-${XY[s] || 'modified'}`, title: XY[s] || f.xy }, s), h('span', { class: 'mono' }, f.path)));
        }),
      ),
      msg,
      h('div', { class: 'gmodal-actions' }, h('span', { class: 'muted small' }, 'Format: ', code('VLEARN-123: description'), ' — no Co-authored-by.'), h('span', { class: 'spacer' }), actBtn('Commit', submit, { primary: true })),
    ),
  );
  msg.focus();
  msg.addEventListener('keydown', (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit());
}

// Live log of a git job; stays open so the output can be read, offers conflict actions when it stops on one.
async function showJob(id) {
  const status = h('span', { class: 'gchip' }, 'running');
  const log = h('pre', { class: 'glog' });
  const extra = h('div');
  const dlg = modal('Git', h('div', { class: 'gmodal-body' }, h('div', { class: 'gjob-head' }, status), log, extra));
  const title = $('h2', dlg.el);
  for (;;) {
    let job;
    try {
      job = await api(`/api/git/jobs/${id}`);
    } catch (e) {
      status.textContent = 'error';
      extra.replaceChildren(h('div', { class: 'error-box' }, e.message));
      return null;
    }
    title.textContent = job.title;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = job.log.join('\n');
    if (atBottom) log.scrollTop = log.scrollHeight;
    status.textContent = job.status;
    status.className = `gchip ${job.status === 'ok' ? 'ok' : job.status === 'running' ? 'accent' : 'warn'}`;
    if (job.status === 'running') {
      // Closed while running: the job keeps going on the server; keep polling quietly for the result.
      await new Promise((r) => setTimeout(r, dlg.el.isConnected ? 700 : 1500));
      continue;
    }
    refreshGit();
    if (job.status === 'ok') toast(job.result?.branch ? `Ready: ${job.result.branch} (${job.result.repos.join(', ')})` : `${job.title}: done`);
    if (job.status === 'ok' && job.result?.branch) setTimeout(dlg.close, 1200);
    if (job.status === 'error') extra.replaceChildren(h('div', { class: 'error-box' }, job.error));
    if (job.status === 'conflict') {
      const c = job.result;
      extra.replaceChildren(
        h(
          'div',
          { class: 'gconflict' },
          h('div', null, h('b', null, `${c.op} stopped on a conflict`), ' in ', code(c.dir)),
          c.files?.length > 0 && h('ul', { class: 'gfiles' }, c.files.map((f) => h('li', { class: 'mono' }, f))),
          h('div', { class: 'muted small' }, 'Resolve the files in the editor (remove the conflict markers), then Continue. A backup was taken before — Undo restores it.'),
          h('div', { class: 'gstep-act' }, conflictActions(job.repo, c.dir, c.op)),
        ),
      );
    }
    return job;
  }
}

// ---------------------------------------------------------------------------
// "Git" view

function renderGitView() {
  if (!gitState.overview && !gitState.loading && !gitState.error) loadGit();
  const ov = gitState.overview;
  const head = h(
    'div',
    { class: 'git-head' },
    h('h2', { class: 'section-title' }, icon('branch'), 'Git', ov && h('span', { class: 'muted small' }, ov.root)),
    h('span', { class: 'spacer' }),
    GIT_REPOS.some((r) => gitState.mrData[r]?.error) &&
      h('span', { class: 'small warn-text', title: GIT_REPOS.map((r) => `${r}: ${gitState.mrData[r]?.error || 'ok'}`).join('\n') }, 'MR status unavailable (VPN?)'),
    h('span', { class: 'muted small' }, 'Open a task (click its key) for its step-by-step flow.'),
    actBtn('Reload', loadGit, { iconName: 'refresh' }),
  );
  if (gitState.error) return h('div', null, head, h('div', { class: 'error-box' }, gitState.error));
  if (!ov) return h('div', null, head, h('div', { class: 'muted' }, 'Loading…'));

  return h(
    'div',
    { class: 'git-view' },
    head,
    h('div', { class: 'grepos' }, GIT_REPOS.map((r) => repoCard(ov.repos[r]))),
    ticketsInFlight(),
    cleanupSection(),
    jobsSection(),
  );
}

function repoCard(r) {
  if (r.error) return h('div', { class: 'gcard' }, h('h3', null, r.repo), h('div', { class: 'error-box' }, r.error));
  const m = r.main;
  const changed = m.files.length;
  const task = /^(feature|bugfix|hotfix|refactor|docs|chore|test)\//.test(m.branch || '');
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
      task && (!m.upstream || m.ahead > 0) && actBtn('Push', () => gitAction({ action: 'push', repo: r.repo, branch: m.branch }), { iconName: 'upload' }),
      actBtn('Fetch', () => gitAction({ action: 'fetch', repo: r.repo }), { iconName: 'download' }),
      actBtn('Cursor', () => openInCursor(r.repo, r.dir), { iconName: 'code' }),
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
              w.op ? h('div', { class: 'gstep-act' }, conflictActions(r.repo, w.path, w.op)) : h('div', { class: 'gstep-act' }, actBtn('Cursor', () => openInCursor(r.repo, w.path), { iconName: 'code' })),
            ),
          ),
        ),
      ),
  );
}

// Tickets that have -uat / -develop branches locally, newest first.
function ticketsInFlight() {
  const tickets = new Map();
  for (const repo of GIT_REPOS) {
    for (const b of gitState.branches[repo]?.branches || []) {
      if (b.kind !== 'task' || !b.tickets.length) continue;
      const t = tickets.get(b.tickets[0]) || { key: b.tickets[0], date: 0, repos: {} };
      t.date = Math.max(t.date, b.date);
      (t.repos[repo] ||= []).push(b);
      tickets.set(t.key, t);
    }
  }
  const list = [...tickets.values()].sort((a, b) => b.date - a.date).slice(0, 25);
  const chip = (repo, b) => {
    const mr = mrsOf(gitState.mrData[repo], b.name)[0];
    if (mr) {
      const conflict = mr.state === 'opened' && mr.conflicts;
      return h(
        'a',
        { class: `gchip ${conflict ? 'danger' : MR_STATE[mr.state]?.[1] || ''}`, href: mr.url, target: '_blank', rel: 'noopener', title: `${b.name}\n!${mr.iid} ${mr.title} → ${mr.target}\n${mrFactsText(mr)}`, onClick: (e) => e.stopPropagation() },
        `${b.suffix} · !${mr.iid} ${conflict ? 'conflict' : mrLabel(mr)}${mr.comments ? ` · 💬${mr.comments}` : ''}`,
      );
    }
    const kind = b.gone ? 'gone' : b.mergedToUat ? 'ok' : b.worktree ? 'accent' : '';
    const known = !!gitState.mrData[repo]?.byBranch; // MR list loaded: absence means there is none
    const why = [b.name, known && 'no MR', b.gone && 'origin branch deleted', b.mergedToUat && 'already in uat', b.worktree && `checked out: ${b.worktree}`].filter(Boolean).join('\n');
    return gitChip(`${b.suffix || 'branch'}${known ? ' · no MR' : ''}`, kind, why);
  };
  return h(
    'section',
    { class: 'gsection' },
    h('h2', { class: 'section-title' }, 'Tickets in flight', h('span', { class: 'muted small' }, list.length)),
    list.length
      ? h(
          'div',
          { class: 'gtable' },
          h('div', { class: 'gtr gth' }, h('div', null, 'Ticket'), h('div', null, 'Summary'), h('div', null, 'Backend'), h('div', null, 'Frontend'), h('div', null, 'Last commit')),
          list.map((t) => {
            const issue = state.issues.find((i) => i.key === t.key);
            return h(
              'div',
              { class: 'gtr', onClick: () => openDetail(t.key) },
              h('div', null, h('a', { class: 'key', href: '#' + t.key }, t.key)),
              h('div', { class: 'gsubj' }, issue ? issue.summary : h('span', { class: 'muted' }, '—')),
              GIT_REPOS.map((r) => h('div', { class: 'gchips' }, (t.repos[r] || []).sort((a, b) => (a.suffix === 'uat' ? 0 : 1) - (b.suffix === 'uat' ? 0 : 1)).map((b) => chip(r, b)))),
              h('div', { class: 'muted small' }, rel(new Date(t.date * 1000).toISOString())),
            );
          }),
        )
      : h('div', { class: 'empty-state' }, 'No task branches.'),
  );
}

function cleanupSection() {
  const reasons = (repo, b) =>
    [
      ['merged', 'closed'].includes(mrsOf(gitState.mrData[repo], b.name)[0]?.state) && `MR ${mrsOf(gitState.mrData[repo], b.name)[0].state}`,
      b.kind === 'backup' && 'backup/*',
      b.gone && 'gone on origin',
      b.mergedToUat && 'in uat',
      b.kind === 'other' && !['uat', 'develop', 'main'].includes(b.name) && 'non-standard name',
    ].filter(Boolean);
  const cols = GIT_REPOS.map((repo) => {
    const data = gitState.branches[repo];
    if (!data) return h('div', { class: 'gcard' }, h('h3', null, repo), h('div', { class: 'muted' }, 'Loading…'));
    const rows = data.branches.filter((b) => !['uat', 'develop', 'main'].includes(b.name) && (gitState.cleanupAll || reasons(repo, b).length));
    const boxes = new Map();
    const count = h('span', null, 'Delete selected (0)');
    const update = () => (count.textContent = `Delete selected (${[...boxes.values()].filter((x) => x.checked).length})`);
    return h(
      'div',
      { class: 'gcard' },
      h('div', { class: 'gcard-head' }, h('h3', null, repo), h('span', { class: 'muted small' }, `${rows.length} branch(es)`)),
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
                h('span', { class: 'gchips' }, mrsOf(gitState.mrData[repo], b.name).slice(0, 1).map(mrChip), reasons(repo, b).filter((x) => !x.startsWith('MR ')).map((x) => gitChip(x, x === 'in uat' ? 'ok' : 'warn')), b.worktree && gitChip('checked out', 'accent')),
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
        data.backups.olderThan14d > 0 &&
          actBtn(`Prune ${data.backups.olderThan14d} > 14 days`, () => gitAction({ action: 'prune-backups', repo, days: 14 }, `Delete ${data.backups.olderThan14d} dashboard backup ref(s) older than 14 days in ${repo}?`)),
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
