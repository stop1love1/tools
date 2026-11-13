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
  flowOf: new Map(), // key → the last flow read (or { error }), for blocks that list other tickets (a story's subtasks)
  mrs: new Map(), // repo → Promise<{ byBranch, error }>
  mrData: {}, // repo → resolved value of the above
  mrStale: new Set(),
  epics: new Map(), // epic key → Promise<epic view>
  sel: new Map(), // issue key → the open panel of its git block (`${repo}:${stage}`), null once closed
  epicOpen: new Set(), // tickets whose row is expanded in the epic view
  epicTableOpen: new Set(), // epics whose "Tickets on the epic" table is unfolded (folded each time the drawer opens)
  devPreset: new Map(), // `${ticket}:${repo}` → commits just cherry-picked onto the epic, pre-ticked for develop
  devTargets: new Map(), // `${repo}:${ticket}` → the -develop branch chosen in the epic view
  pipes: new Map(), // CI pipelines, see getPipelines
  pipesLoading: new Set(),
  unticked: new Map(), // commit list (scope) → shas the user unticked: survives the redraws MR / title loading cause
  epicTitles: new Map(), // epic key → { ticket: summary }
  jiraMrs: new Map(), // ticket → MR links recorded on Jira (shown when GitLab can't be reached)
  cleanupAll: false,
  branchSprints: {}, // ticket key → sprint (or null), looked up by key so closed tickets outside the default JQL still map
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
    p.then(
      (f) => gitState.flowOf.set(key, f),
      (e) => (gitState.flows.delete(id), gitState.flowOf.set(key, { error: e.message })),
    );
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

// CI pipelines. The team's CI runs on MR events and on pushes to develop / uat — so a branch's pipeline is its MR's.
// gitState.pipes: `${repo}:mr:${iid}` | `${repo}:ref:${ref}` → { at, value }. Never awaited by a render.
const PIPE_LIVE = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled']);
const pipeOf = (repo, iid) => gitState.pipes.get(`${repo}:mr:${iid}`)?.value || null;
const refPipeOf = (repo, ref) => gitState.pipes.get(`${repo}:ref:${ref}`)?.value || null;
// Fetches what is missing or still running (re-read after 8s); → a promise when something was fetched, else null.
function getPipelines(repo, iids = [], refs = []) {
  const stale = (k) => {
    const hit = gitState.pipes.get(k);
    return !hit || (PIPE_LIVE.has(hit.value?.status) && Date.now() - hit.at > 8_000);
  };
  const mrs = [...new Set(iids)].filter((i) => stale(`${repo}:mr:${i}`) && !gitState.pipesLoading.has(`${repo}:mr:${i}`)).slice(0, 10);
  const rs = [...new Set(refs)].filter((r) => stale(`${repo}:ref:${r}`) && !gitState.pipesLoading.has(`${repo}:ref:${r}`));
  if (!mrs.length && !rs.length) return null;
  const keys = [...mrs.map((i) => `${repo}:mr:${i}`), ...rs.map((r) => `${repo}:ref:${r}`)];
  keys.forEach((k) => gitState.pipesLoading.add(k));
  const q = new URLSearchParams([['repo', repo], ...mrs.map((i) => ['mr', i]), ...rs.map((r) => ['ref', r])]);
  return api(`/api/git/pipelines?${q}`)
    .then((d) => {
      const at = Date.now();
      for (const [i, v] of Object.entries(d.mrs || {})) gitState.pipes.set(`${repo}:mr:${i}`, { at, value: v });
      for (const [r, v] of Object.entries(d.refs || {})) gitState.pipes.set(`${repo}:ref:${r}`, { at, value: v });
    })
    .catch(() => {})
    .finally(() => keys.forEach((k) => gitState.pipesLoading.delete(k)));
}
const PIPE_LOOK = {
  success: ['✓', 'passed', 'ok'],
  failed: ['✗', 'failed', 'danger'],
  running: ['●', 'running', 'accent'],
  pending: ['◌', 'pending', ''],
  created: ['◌', 'created', ''],
  waiting_for_resource: ['◌', 'waiting', ''],
  preparing: ['◌', 'preparing', ''],
  scheduled: ['◌', 'scheduled', ''],
  canceled: ['⊘', 'canceled', 'gone'],
  skipped: ['»', 'skipped', 'gone'],
  manual: ['▶', 'manual', 'warn'],
};
// A pipeline as a chip linking to it on GitLab; a failed one names its failed jobs. what: "MR !3700", "develop deploy"…
function pipeChip(p, what = '') {
  if (!p) return null;
  const [mark, word, kind] = PIPE_LOOK[p.status] || ['?', p.status, ''];
  const failed = p.failed?.length ? ` · ${p.failed.map((j) => j.name).slice(0, 2).join(', ')}${p.failed.length > 2 ? ` +${p.failed.length - 2}` : ''}` : '';
  return h(
    'a',
    {
      class: `gchip pipechip ${kind}${PIPE_LIVE.has(p.status) ? ' live' : ''}`,
      href: p.url,
      target: '_blank',
      rel: 'noopener',
      title: `Pipeline #${p.id}${what ? ` of ${what}` : ''}: ${word}${p.failed?.length ? `\nFailed jobs:\n${p.failed.map((j) => `· ${j.stage} / ${j.name}`).join('\n')}` : ''}\n${p.ref} @ ${p.sha} · ${rel(p.updated)}\nClick to open on GitLab`,
    },
    icon('pipeline'),
    `${mark} ${word}${failed}`,
  );
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
    loadBranchSprints();
  } catch (e) {
    gitState.error = e.message;
  } finally {
    gitState.loading = false;
    if (state.view === 'git') render();
  }
  for (const r of gitRepos()) getMrs(r).then(() => state.view === 'git' && render());
}

// Sprint of every ticket the local branches name; fills in behind the first render.
async function loadBranchSprints() {
  const keys = [...new Set(Object.values(gitState.branches).flatMap((d) => d.branches.flatMap((b) => b.tickets)))];
  if (!keys.length) return;
  try {
    const q = new URLSearchParams(keys.map((k) => ['key', k]));
    gitState.branchSprints = (await api(`/api/git/branch-sprints?${q}`)).sprints;
    if (state.view === 'git') render();
  } catch {
    // Jira unreachable: the sprint filter falls back to the issues already loaded.
  }
}

// After a job: drop cached flows and redraw whatever shows git state.
function refreshGit() {
  gitState.flows.clear();
  gitState.flowOf.clear();
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
  get 'rebuild-develop'() {
    return `Rebuild from ${DEV()}`;
  },
  'pick-epic': 'Cherry-pick to epic',
  skip: 'Skip commit',
  abort: 'Abort',
  undo: 'Undo',
  'delete-branches': 'Delete branches',
  'prune-backups': 'Prune backups',
  'stash-pop': 'Pop stash',
};
const DANGER_ACTIONS = new Set(['rebase-epic', 'rebuild-develop', 'abort', 'undo', 'delete-branches', 'prune-backups']);

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

// ---------------------------------------------------------------------------
// Actions as data: each is defined once and drawn where it is shown — the main button of a "Next" item or a
// panel, a plain button, or a link under "Other options".

const act = (label, run, opts = {}) => ({ label, run, ...opts }); // opts: icon, danger, title
const linkAct = (label, href, opts = {}) => ({ label, href, icon: 'mr', ...opts });

function actEl(a, kind = 'secondary') {
  if (!a) return null;
  if (a.el) return a.el;
  if (kind === 'more') {
    const cls = `link-btn${a.danger ? ' danger-text' : ''}`;
    return a.href ? h('a', { class: cls, href: a.href, target: '_blank', rel: 'noopener', title: a.title }, a.label) : h('button', { class: cls, title: a.title, onClick: a.run }, a.label);
  }
  const cls = `btn sm${kind === 'primary' && !a.danger ? ' primary' : ''}${a.danger ? ' danger' : ''}`;
  const kids = [a.icon && icon(a.icon), a.label];
  return a.href ? h('a', { class: cls, href: a.href, target: '_blank', rel: 'noopener', title: a.title }, kids) : h('button', { class: cls, title: a.title, onClick: a.run }, kids);
}

const pushAct = (repo, b) =>
  b.sync?.onlyB > 0 ? forcePushAct(repo, b.name) : act('Push', () => gitAction({ action: 'push', repo, branch: b.name }), { icon: 'upload' });

// Local and origin diverged (after a rebase / undo): replace origin's version, with lease.
const forcePushAct = (repo, branch) =>
  act('Force-push', () => gitAction({ action: 'push', repo, branch, force: true }, `${branch} on origin differs from local (after a rebase / undo).\n\nForce-push with lease, replacing origin's version?`), {
    danger: true,
    icon: 'upload',
  });
const forcePushBtn = (repo, branch) => actEl(forcePushAct(repo, branch));

// Back to the newest backup ref of a branch (taken before every rebase / cherry-pick / reset).
const undoAct = (repo, b) =>
  b?.backups?.length > 0 &&
  act(`Undo on ${b.name}`, () => gitAction({ action: 'undo', repo, branch: b.name }, `Reset ${b.name} to its backup from ${fmtDate(b.backups[0].at)}?`), {
    danger: true,
    title: `Back to ${b.backups[0].sha} (backed up ${rel(b.backups[0].at)})`,
  });

// The task branch is the user's own and a backup is kept (Undo), so no confirm.
const rebaseTaskAct = (repo, epicKey, b) =>
  act('Rebase & push', () => gitAction({ action: 'sync-task', repo, epic: epicKey, branch: b.name }), {
    icon: 'rebase',
    title: `Rebase ${b.name} onto origin/epic/${epicKey} and ${b.remote ? 'force-push it (with lease)' : 'push it'} — a backup is kept (Undo)`,
  });

// The team rule (git-workflow.mdc step 4): a pushed epic that fell behind / conflicts with uat is NOT rebased or
// force-pushed — tell the lead, resolve on the epic → uat MR (or fix on a task branch and pick it). So this is never a
// "next step"; it sits under "Other options" for when the lead decides to rebase anyway.
const EPIC_CONFLICT_WHY = () =>
  `Team rule: don't rebase / force-push the epic. Tell the lead, then resolve on the epic → ${UAT()} MR (GitLab "Resolve conflicts"), or fix it on a task branch and cherry-pick that onto the epic.`;
const rebaseEpicAct = (repo, epicKey) =>
  act(
    `Rebase & force-push the epic onto ${UAT()} (only if the lead asks)…`,
    () =>
      gitAction(
        { action: 'rebase-epic', repo, epic: epicKey },
        `The team rule says NOT to rebase / force-push a pushed epic. Only go on if the lead decided so.\n\nRebase epic/${epicKey} onto origin/${UAT()} (keeping each task's merge commit) and FORCE-PUSH it? Open task branches will need a rebase afterwards.`,
      ),
    // Not red: it's an escape hatch, not an alert (the confirm dialog is still the danger one).
    { icon: 'rebase', title: `Rebase epic/${epicKey} onto ${UAT()} — force-push (against the team rule)` },
  );

// develop was rewritten after the -develop branch was cut: replay its own commits on the new develop.
const rebuildDevAct = (repo, branch, merges) =>
  act(
    `Rebuild from ${DEV()}`,
    () =>
      gitAction(
        { action: 'rebuild-develop', repo, branch },
        `${branch} carries ${merges} merge commit(s) that ${DEV()} no longer has: ${DEV()} was rewritten (reset / force-pushed) after the branch was cut. Its MR would bring them all back.\n\nRecreate it from origin/${DEV()} with only its own commits (the ones on top of the old base) and force-push it (with lease)? A backup is kept (Undo).`,
      ),
    { icon: 'rebase', title: `Replay ${branch}'s own commits on origin/${DEV()} and force-push` },
  );

// Commit checkboxes that keep what the user unticked across redraws. scope: one list (`${repo}:${ticket}:dev` …).
const unticked = (scope) => (gitState.unticked.has(scope) ? gitState.unticked.get(scope) : gitState.unticked.set(scope, new Set()).get(scope));
const tickedOf = (scope, list) => list.filter((c) => !unticked(scope).has(c.sha));
const tickBox = (scope, c, onChange) =>
  h('input', {
    type: 'checkbox',
    checked: !unticked(scope).has(c.sha),
    value: c.sha,
    'aria-label': c.subject,
    onChange: (e) => {
      e.target.checked ? unticked(scope).delete(c.sha) : unticked(scope).add(c.sha);
      onChange?.();
    },
  });

// Why a commit is left out of a pick: it was reverted later on the branch, or it is that revert.
const skipText = (x) => (x?.skip === 'reverted' ? `reverted by ${x.by}` : x?.skip === 'revert' ? `reverts ${x.of.join(', ')}` : '');

// The -develop branch conflicts with develop: rebase it onto develop and push (own branch, backup kept → no confirm).
const syncDevAct = (repo, branch) =>
  act(`Rebase onto ${DEV()}`, () => gitAction({ action: 'sync-develop', repo, branch }), {
    icon: 'rebase',
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

// MR description skeleton in the team format (git-workflow.mdc, 2026-10-23: Vietnamese, like the epic MRs). The uat
// and develop MRs of the same diff must carry the same title and description, so the develop branch isn't named here.
function mrDescription(key, epicBranch) {
  const epicKey = (epicBranch || '').replace(/^epic\//, '') || key;
  const site = CFG.jira.siteUrl || 'https://vin3s.atlassian.net';
  return [
    '## Mục đích', '',
    `Epic [${epicKey}](${String(site).replace(/\/$/, '')}/browse/${epicKey}): <tên tính năng> — <1–2 câu: giải quyết gì, cho ai>.`, '',
    `Stories: ${key} (<phần>)`, '',
    '<Repo kia> tương ứng: !<n> (uat) · develop: chưa tạo', '',
    'PRD: [<tên PRD>](<link Confluence>)', '',
    '## Các phần đã làm', '',
    `**<Nhóm thay đổi> (${key})**`, '- <hành vi thay đổi — không liệt kê path file>', '',
    '**Khác**', '- không có', '',
    '## API changes', '',
    '| Method | Endpoint | Thay đổi | Chi tiết |', '|---|---|---|---|', '| | | **Mới** / **Sửa** | |', '',
    'Tương thích ngược: <…>.', '',
    '## Cấu hình khi deploy', '',
    '1. **Migration**: không có.', '2. **Biến môi trường**: không có biến mới.', '3. **Backfill**: không có.', '4. **Phân quyền**: không có quyền mới.', '5. **Phụ thuộc FE/BE**: không có.', '',
    '## Kiểm tra', '',
    '- <hook / build / lint đã chạy>', '- <unit test>', '- <test tay; ghi rõ phần chưa test>',
  ].join('\n');
}

// iconOnly: secondary / repeated actions show just their icon (label becomes the tooltip + aria-label).
const actBtn = (label, onClick, { primary, danger, iconName, title, disabled, iconOnly } = {}) =>
  iconOnly
    ? h('button', { class: `icon-btn sm outline gicon${danger ? ' danger' : ''}`, title: title || label, 'aria-label': label, disabled, onClick }, icon(iconName))
    : h('button', { class: `btn sm${primary ? ' primary' : ''}${danger ? ' danger' : ''}`, title, disabled, onClick }, iconName && icon(iconName), label);

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
