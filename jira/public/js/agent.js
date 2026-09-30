'use strict';

// "Start with Claude": a dialog whose choices (repos, plan or implement, which MRs, draft, Jira status, notes) become
// a short prompt for a Claude Code chat opened in Cursor (copied to the clipboard at the same time, as before):
// "call task_brief with these options". The MCP tool returns the ticket, git state and steps (lib/prompt.js).
// Without MCP the ticket itself is attached instead. Uses modal() from git/dialogs.js.

const MR_KIND_LABELS = {
  'task-epic': () => `Task → epic (-${UAT()} branch → epic/…)`,
  'epic-uat': () => `Epic → ${UAT()}`,
  develop: () => `Develop (cherry-pick → -${DEV()} → ${DEV()})`,
};
const MODES = { implement: 'Implement & open MR', plan: 'Plan only' };

function startWithClaude(issue) {
  const saved = LS.get('agentOpts', {});
  const box = (checked, extra = {}) => h('input', { type: 'checkbox', checked, ...extra });
  const pick = guessRepos(issue);
  const repoBoxes = gitRepos().map((r) => box(pick.includes(r), { value: r }));
  let mode = MODES[saved.mode] ? saved.mode : 'implement';
  const tabs = h(
    'div',
    { class: 'gtabs agent-mode' },
    Object.entries(MODES).map(([m, label]) => h('button', { type: 'button', 'data-mode': m, onClick: () => setMode(m) }, label)),
  );
  const kinds = Object.keys(MR_KIND_LABELS);
  const kindBoxes = kinds.map((k) => box((saved.mrKinds || ['task-epic']).includes(k), { value: k }));
  const draft = box(!!saved.draft);
  const moveStatus = box(saved.moveStatus ?? true);
  const notes = h('textarea', { class: 'gin', rows: '3', placeholder: 'Anything Claude should know: scope, approach, files, what to skip…' });
  const implementOnly = h(
    'div',
    { class: 'agent-implement' },
    h('div', { class: 'agent-field' }, h('b', null, 'Open MRs for'), h('div', { class: 'agent-checks' }, kinds.map((k, i) => h('label', null, kindBoxes[i], MR_KIND_LABELS[k]())))),
    h('div', { class: 'agent-field' }, h('b', null, 'Options'), h('div', { class: 'agent-checks' }, h('label', null, draft, 'Draft MR'), h('label', null, moveStatus, 'Move Jira status (In Development → In Review)'))),
  );
  const setMode = (m) => {
    mode = m;
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    implementOnly.hidden = m === 'plan';
  };
  setMode(mode);

  const start = async () => {
    const options = {
      key: issue.key,
      repos: repoBoxes.filter((b) => b.checked).map((b) => b.value),
      mode,
      mrKinds: kindBoxes.filter((b) => b.checked).map((b) => b.value),
      draft: draft.checked,
      moveStatus: moveStatus.checked,
      notes: notes.value.trim(),
    };
    if (!options.repos.length) return toast('Pick at least one repo', 'error');
    LS.set('agentOpts', { mode, mrKinds: options.mrKinds, draft: options.draft, moveStatus: options.moveStatus });
    startBtn.disabled = true;
    try {
      const { prompt } = await api('/api/claude/prompt', { method: 'POST', body: JSON.stringify(options) });
      // With MCP on, Claude loads the ticket itself (task_brief); otherwise it gets the ticket in the prompt.
      const detail = CFG.agent?.mcp ? null : await getDetail(issue.key).catch(() => null);
      dlg.close();
      sendToClaude(issue, detail, detail ? `${prompt}\n\n---\nThe jira-dashboard MCP is off; the ticket:\n\n${issueMarkdown(issue, detail)}`.slice(0, 11_500) : prompt);
    } catch (e) {
      startBtn.disabled = false;
      toast(e.message, 'error');
    }
  };

  const settingsLink = (label) => h('button', { class: 'link-btn', onClick: () => (dlg.close(), setView('settings')) }, label);
  // The MCP state decides what Claude can do by itself.
  const mcpNote = !CFG.agent?.mcp
    ? h('div', { class: 'gconflict ghint' }, 'MCP is off: the ticket is pasted into the prompt instead of loaded by Claude. ', settingsLink('Turn it on'))
    : !CFG.agent?.writes &&
      h(
        'div',
        { class: 'muted small' },
        'Write tools are off: Claude reads the ticket through MCP and does branch / commit / MR with git itself. ',
        settingsLink('Allow write tools'),
        ' to have it use the dashboard steps and the MR template.',
      );
  const startBtn = h('button', { class: 'btn sm primary', onClick: start }, icon('play'), 'Start');
  const dlg = modal(
    `Start ${issue.key} with Claude`,
    h(
      'div',
      { class: 'gmodal-body agent-start' },
      h('div', { class: 'agent-issue' }, typeBadge(issue.type?.name), h('b', null, issue.key), h('span', { class: 'gsubj', title: issue.summary }, issue.summary)),
      tabs,
      h('div', { class: 'agent-field' }, h('b', null, 'Repos'), h('div', { class: 'agent-checks' }, gitRepos().map((r, i) => h('label', null, repoBoxes[i], repoLabel(r))))),
      implementOnly,
      h('div', { class: 'agent-field' }, h('b', null, 'Notes'), notes),
      mcpNote,
      h('div', { class: 'muted small' }, 'Start copies a short prompt and opens a Claude Code tab in Cursor. Claude loads the ticket, its git state and the steps from the dashboard MCP (task_brief).'),
      h('div', { class: 'gmodal-actions' }, h('span', { class: 'spacer' }), actBtn('Cancel', () => dlg.close()), startBtn),
    ),
  );
}
