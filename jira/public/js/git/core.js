'use strict';

// Git flow UI for the configured repos: the "Git flow" block in an issue's drawer and the Workspace view
// (repos, tickets in flight, branch cleanup, recent jobs). Server side: ../../lib/git/.
// These scripts only define functions; they use the app helpers (h, icon, api, toast…) at call time.
// This file: state, data, actions and small shared pieces.

// Configured branch names and project key (Settings → Git flow).
const UAT = () => CFG.git.uat;
const DEV = () => CFG.git.develop;
const KEY = () => CFG.git.projectKey;
const uatSuffixRe = () => new RegExp(`-${UAT()}$`);
// The -develop twin of a -uat (or older suffix-less) task branch; same rule as the server's toDevelop.
const toDevName = (b) => (uatSuffixRe().test(b) ? b.replace(uatSuffixRe(), `-${DEV()}`) : `${b}-${DEV()}`);
const devBranchRe = () => new RegExp(`^(${CFG.git.branchTypes.join('|')})/${KEY()}-\\d+-[a-z0-9._-]+-${DEV()}$`);

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
  jiraMrs: new Map(), // ticket → MR links recorded on Jira (shown when GitLab can't be reached)
  cleanupAll: false,
};

// ---------------------------------------------------------------------------
// Data

function epicOverride(key) {
  return LS.get('gitEpic', {})[key] || '';
}

// The task branch the user chose per repo when a ticket has several: { [repo]: branch }.
const branchPins = (key) => LS.get('gitBranch', {})[key] || {};
function pinBranch(key, repo, branch) {
  const all = LS.get('gitBranch', {});
  const mine = { ...all[key], [repo]: branch || undefined };
  all[key] = Object.values(mine).some(Boolean) ? mine : undefined;
  LS.set('gitBranch', all);
  refreshGit();
}

function getFlow(key, { fresh = false } = {}) {
  const epic = epicOverride(key);
  const pins = Object.entries(branchPins(key)).filter(([, b]) => b);
  const id = `${key}|${epic}|${pins.map((p) => p.join(':')).join(',')}`;
  if (fresh || !gitState.flows.has(id)) {
    const q = new URLSearchParams({ key });
    if (epic) q.set('epic', epic);
    for (const p of pins) q.append('pin', p.join(':'));
    const p = api(`/api/git/flow?${q}`);
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

// Does a merge conflict? The server's local check (`git merge-tree`: works off VPN, before the MR exists and while
// GitLab still says "checking"), else GitLab's has_conflicts on the open MR. → { files } or null.
const conflictOf = (m, local) => local || (m?.state === 'opened' && m.conflicts ? { files: [] } : null);
const conflictChip = (c, target) =>
  c ? gitChip(`⚠ conflicts with ${target}${c.files.length ? ` · ${c.files.length} file${c.files.length > 1 ? 's' : ''}` : ''}`, 'danger', c.files.length ? `Merging would conflict in:\n${c.files.join('\n')}` : 'GitLab reports merge conflicts') : null;
// An MR whose conflict is already shown by conflictChip: keep its other facts, drop the duplicate conflict chip.
const sansConflict = (m) => m && { ...m, conflicts: false };
const conflictFiles = (c) => (c?.files.length ? ` in ${c.files.slice(0, 3).join(', ')}${c.files.length > 3 ? ` +${c.files.length - 3}` : ''}` : '');

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
      ...gitRepos().map((r) => api(`/api/git/branches?repo=${r}`)),
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
  for (const r of gitRepos()) getMrs(r).then(() => state.view === 'git' && render());
}

// After a job: drop cached flows and redraw whatever shows git state.
function refreshGit() {
  gitState.flows.clear();
  gitState.epics.clear();
  gitState.mrs.clear();
  for (const r of gitRepos()) gitState.mrStale.add(r);
  if (state.view === 'git') loadGit();
  const block = $('#git-flow');
  const issue = state.issues.find((i) => i.key === state.openKey) || state.openIssue;
  if (block && issue) block.replaceWith(gitFlowBlock(issue));
}

// An MR opened / created on GitLab in another tab: re-read MR states when the user comes back.
let mrVisited = false;
for (const type of ['click', 'auxclick']) document.addEventListener(type, (e) => e.target.closest?.('a[href*="/-/merge_requests"]') && (mrVisited = true), true);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !mrVisited) return;
  mrVisited = false;
  refreshGit();
});

// Getters: branch names can change in Settings without a reload.
const ACTION_TITLES = {
  'ensure-epic': 'Create epic',
  'create-task': 'Create branch',
  checkout: 'Checkout',
  push: 'Push',
  'sync-task': 'Rebase onto epic',
  get 'sync-develop'() {
    return `Rebase onto ${DEV()}`;
  },
  get 'rebase-epic'() {
    return `Rebase epic onto ${UAT()}`;
  },
  get 'pick-develop'() {
    return `Cherry-pick to ${DEV()}`;
  },
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
    return await showJob(id, { started: true });
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

// Local and origin diverged (after a rebase / undo): replace origin's version, with lease.
const forcePushBtn = (repo, branch) =>
  actBtn('Force-push', () => gitAction({ action: 'push', repo, branch, force: true }, `${branch} on origin differs from local (after a rebase / undo).\n\nForce-push with lease, replacing origin's version?`), {
    danger: true,
    iconName: 'upload',
  });

// The epic is behind / conflicts with uat: rebase it (keeping each task's merge commit) and force-push. Shared branch → confirm.
const rebaseEpicBtn = (repo, epicKey, { iconOnly = true } = {}) =>
  actBtn(
    `Rebase epic onto ${UAT()}`,
    () =>
      gitAction(
        { action: 'rebase-epic', repo, epic: epicKey },
        `Rebase epic/${epicKey} onto origin/${UAT()} (keeping each task's merge commit) and FORCE-PUSH it?\n\nThe epic is shared: tell the team first. Open task branches will need a rebase afterwards.`,
      ),
    { danger: true, iconOnly, iconName: 'rebase', title: `Rebase epic/${epicKey} onto ${UAT()} — force-push` },
  );

// The -develop branch conflicts with develop: rebase it onto develop and push (own branch, backup kept → no confirm).
const syncDevBtn = (repo, branch) =>
  actBtn(`Rebase onto ${DEV()}`, () => gitAction({ action: 'sync-develop', repo, branch }), {
    primary: true,
    iconName: 'rebase',
    title: `Rebase ${branch} onto origin/${DEV()} and force-push it (with lease) — a backup is kept (Undo)`,
  });

// Switch the repo's own checkout; uncommitted work is stashed (after asking) and comes back on the way back.
function checkoutBranch(repo, branch, dirty) {
  if (!dirty) return gitAction({ action: 'checkout', repo, branch });
  return gitAction(
    { action: 'checkout', repo, branch, stash: true },
    `${dirty} uncommitted file(s) in ${repoLabel(repo)}.\n\nStash them and switch to ${branch}? They are re-applied when you switch back from the dashboard.`,
  );
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
const ticketOf = (branch) => (branch || '').match(ticketRe())?.[0] || null;

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
    '## Checklist', '', ...CFG.git.mrChecklist.map((c) => `- [ ] ${c}`), '',
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

// iconOnly: secondary / repeated actions show just their icon (label becomes the tooltip + aria-label).
const actBtn = (label, onClick, { primary, danger, iconName, title, disabled, iconOnly } = {}) =>
  iconOnly
    ? h('button', { class: `icon-btn sm outline gicon${danger ? ' danger' : ''}`, title: title || label, 'aria-label': label, disabled, onClick }, icon(iconName))
    : h('button', { class: `btn sm${primary ? ' primary' : ''}${danger ? ' danger' : ''}`, title, disabled, onClick }, iconName && icon(iconName), label);

const iconLink = (href, iconName, label) =>
  h('a', { class: 'icon-btn sm outline gicon', href, target: '_blank', rel: 'noopener', title: label, 'aria-label': label }, icon(iconName));

// Buttons shown wherever a rebase / cherry-pick is stopped on a conflict.
function conflictActions(repo, dir, op) {
  return [
    // Step one of resolving: the conflict may sit in the dashboard's scratch worktree, a folder the user never opened.
    actBtn('Open in Cursor', () => openInCursor(repo, dir), { iconName: 'code', title: dir }),
    actBtn('Continue', () => gitAction({ action: 'continue', repo, dir }), { primary: true, title: 'Stage the resolved files and continue' }),
    actBtn('Skip commit', () => gitAction({ action: 'skip', repo, dir }, `Skip the current commit of this ${op}?`)),
    actBtn('Abort', () => gitAction({ action: 'abort', repo, dir }, `Abort the ${op} and go back to where it started?`), { danger: true }),
  ];
}
