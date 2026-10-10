'use strict';

// Starting a ticket: the branch form and the Start popover.

// ---------------------------------------------------------------------------
// Start a ticket (from its drawer). The task list itself shows no git state: nothing git-related is fetched
// until a ticket's detail is opened.

// Auto-detect repos from issue summary prefix.
// Supports patterns: [FE], FE:, FE, FE-, FE/, "FE " at the start, and combinations like [FE][BE], FE/BE
function guessRepos(issue) {
  const repos = gitRepos();
  const TAGS = { fe: 'front', frontend: 'front', be: 'back', backend: 'back' };
  const picked = [];
  let rest = issue.summary || '';
  // Leading tags, up to 3 groups: "[FE]", "FE:", "FE,", "FE -", "FE ", "[FE][BE]", "FE/BE:", "[fe/be]".
  for (let i = 0; i < 3; i++) {
    const m = rest.match(/^\s*(?:\[([^\]]*)\]|([A-Za-z]+(?:\s*[\/+&]\s*[A-Za-z]+)*)(\s*[:,\-–|]|\s|$))/);
    if (!m) break;
    const bracketed = m[1] !== undefined;
    const names = (bracketed ? m[1] : m[2]).split(/[^A-Za-z]+/).filter(Boolean);
    // A bare word followed only by a space must be upper case ("FE Foo", not "Be able to…").
    const bareWord = !bracketed && !/[:,\-–|]/.test(m[3]);
    if (!names.length || !names.every((n) => TAGS[n.toLowerCase()]) || (bareWord && names.some((n) => n !== n.toUpperCase()))) break;
    for (const n of names) {
      const repo = repos.find((r) => r.startsWith(TAGS[n.toLowerCase()]));
      if (repo && !picked.includes(repo)) picked.push(repo);
    }
    rest = rest.slice(m[0].length);
  }
  // No recognised tag: FE is the default.
  return picked.length ? picked : [repos.find((r) => r.startsWith('front')) || repos[0]].filter(Boolean);
}

// Everything needed to start coding a ticket, in one popover: type + short description (+ BE/FE, stash, Jira status).
async function startTaskPop(issue, { repos, preset } = {}) {
  const form = branchForm(issue, preset);
  const pickRepos = repos || guessRepos(issue);
  const repoBoxes = gitRepos().map((r) => h('input', { type: 'checkbox', value: r, checked: pickRepos.includes(r) }));
  const stash = h('input', { type: 'checkbox', checked: true });
  const jira = h('input', { type: 'checkbox', checked: issue.status?.category === 'new' });
  const opts = h(
    'div',
    { class: 'gstart-opts' },
    h('div', { class: 'gchecks' }, gitRepos().map((r, i) => h('label', null, repoBoxes[i], repoLabel(r)))),
    h('label', null, stash, 'Stash uncommitted changes & checkout'),
    issue.status && issue.status.category !== 'done' && h('label', null, jira, 'Move Jira to In Development'),
  );
  const values = await popover({
    title: `Start ${issue.key}`,
    okLabel: 'Start',
    body: [form.el, opts, h('div', { class: 'muted small' }, `Off the epic (created from ${UAT()} if missing). Push & MR come later from the Git flow.`)],
    focus: () => form.input,
    onOk: () => {
      const branch = form.branch();
      const picked = repoBoxes.filter((b) => b.checked).map((b) => b.value);
      if (!branch) return void (toast('Type a short description, e.g. add-export', 'error'), form.focus());
      if (!picked.length) return void toast('Pick at least one repo', 'error');
      return { branch, repos: picked, stash: stash.checked, jira: jira.checked, others: form.others() };
    },
  });
  if (!values) return;
  const job = await gitAction({ action: 'start-task', key: issue.key, epic: epicOverride(issue.key) || undefined, branch: values.branch, repos: values.repos, stash: values.stash });
  if (job?.status === 'ok' && values.jira) for (const i of [issue, ...values.others.map((key) => ({ key }))]) moveToInDevelopment(i);
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

// "type ▾ + short description" → <type>/<KEY>-123-<description>-uat (the -uat suffix is the team rule for task branches).
function branchForm(issue, preset) {
  const type = h('select', { class: 'gin gtype', 'aria-label': 'Branch type' }, CFG.git.branchTypes.map((t) => h('option', { value: t }, t)));
  type.value = CFG.git.branchTypes.find((t) => (/bug/i.test(issue.type.name) ? /bug/.test(t) : t === 'feature')) || CFG.git.branchTypes[0];
  const desc = h('input', { class: 'gin mono gdesc', placeholder: 'short-description', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Short description' });
  // Other tickets sharing this branch: feature/<KEY>-4546-4547-<desc>-uat belongs to both (the Git flow of each finds it).
  const also = h('input', { class: 'gin mono', placeholder: `e.g. 4547, ${KEY()}-4548`, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Other tickets on this branch' });
  const own = issue.key.split('-')[1];
  // Reuse an existing branch name (the ticket already has it in the other repo); an older suffix-less one gets -uat here.
  const m = preset?.match(new RegExp(`^([a-z]+)/${KEY()}-(\\d+(?:-\\d+)*)-(.+?)(?:-${UAT()})?$`));
  if (m && CFG.git.branchTypes.includes(m[1])) {
    type.value = m[1];
    desc.value = m[3];
    also.value = m[2].split('-').filter((n) => n !== own).join(', ');
  }
  const others = () => [...new Set(also.value.match(/\d+/g) || [])].filter((n) => n !== own);
  const preview = h('code', { class: 'gcode' });
  const slug = () => slugify(desc.value, 10).replace(new RegExp(`^${KEY().toLowerCase()}-\\d+-?`), '');
  const ids = () => [own, ...others()].join('-');
  const branch = () => (slug() ? `${type.value}/${KEY()}-${ids()}-${slug()}-${UAT()}` : '');
  const update = () => (preview.textContent = branch() || `${type.value}/${KEY()}-${ids()}-…-${UAT()}`);
  // Enter submits through the popover.
  type.addEventListener('change', update);
  desc.addEventListener('input', update);
  also.addEventListener('input', update);
  update();
  return {
    el: h(
      'div',
      { class: 'gform' },
      h('div', { class: 'gform-row' }, type, h('span', { class: 'mono muted gfix' }, `/${issue.key}-`), desc, h('span', { class: 'mono muted gfix' }, `-${UAT()}`)),
      h('div', { class: 'gform-row' }, h('span', { class: 'muted small gfix' }, 'Also for tickets'), also),
      h('div', { class: 'gstep-note' }, '→ ', preview),
    ),
    branch,
    others: () => others().map((n) => `${KEY()}-${n}`),
    input: desc,
    focus: () => desc.focus(),
  };
}
