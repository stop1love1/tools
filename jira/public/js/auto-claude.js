'use strict';

// Auto Claude on the Tasks page: the header switch and its dialog. The work itself runs on the server
// (lib/auto-claude.js): every minute it reads my not-started tasks — newly assigned ones included — and, when no task is
// in hand, opens the first ticked one in a Claude Code tab in Cursor. So it keeps going with no dashboard page open
// (desktop app in background mode, or `npm start`). This file only shows the state and sends the changes.

let acView = null; // the last GET /api/auto-claude
let acPoll = null;

async function acLoad() {
  try {
    acView = await api('/api/auto-claude');
  } catch (e) {
    acView = acView ? { ...acView, error: e.message } : null;
  }
  acRender();
  return acView;
}

async function acPost(body) {
  try {
    acView = await api('/api/auto-claude', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    toast(`Auto Claude: ${e.message}`, 'error');
  }
  acRender();
  return acView;
}

// ---------------------------------------------------------------------------
// Header: the switch (a click opens the dialog — it is never turned on without seeing what it will take) and the task
// it is on.

function acRender() {
  const slot = document.getElementById('auto-claude-slot');
  if (!slot) return;
  let box = document.getElementById('auto-claude');
  if (!box) {
    box = h('div', { class: 'auto-claude', id: 'auto-claude' });
    slot.prepend(box);
  }
  const on = !!acView?.on;
  const sw = h(
    'button',
    {
      class: `ac-switch${on ? ' on' : ''}`,
      role: 'switch',
      'aria-checked': String(on),
      'aria-haspopup': 'dialog',
      title: on ? 'Auto Claude is on — open its settings and queue' : 'Auto Claude: open my To Do tasks in Claude Code, one at a time — click to set up and turn on',
      onClick: acDialog,
    },
    h('span', { class: 'ac-knob' }),
    icon('ai'),
    h('span', { class: 'btn-label' }, 'Auto'),
  );
  const cur = on && acView.current;
  const current = cur && h('a', { class: 'ac-current key', href: '#' + cur, title: `Auto Claude is on ${cur}`, onClick: (e) => (e.preventDefault(), openDetail(cur)) }, cur);
  box.replaceChildren(...[sw, current].filter(Boolean));
}

// ---------------------------------------------------------------------------
// Dialog: status, the tasks it will take (with checkboxes), then the settings. Every change is saved at once.

async function acDialog() {
  const body = h('div', { class: 'acd' }, h('div', { class: 'muted small' }, 'Reading your tasks…'));
  const dlg = modal('Auto Claude', body, { onClose: () => acRender() });
  dlg.el.querySelector('.gmodal-box').classList.add('acd-box');
  const v = await acLoad();
  if (!v) return body.replaceChildren(h('div', { class: 'error-box' }, 'Auto Claude is not available on this server — restart it to load the new version.'));
  const cfg = { ...v.cfg };
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z]/g, '');
  const saveCfg = (patch) => (Object.assign(cfg, patch), acPost({ cfg }).then(draw));

  // Controls ------------------------------------------------------------------
  // Segmented choice: one of a few options.
  const seg = (options, value, onPick) =>
    h(
      'div',
      { class: 'acd-seg', role: 'radiogroup' },
      options.map(([val, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(value === val), onClick: () => value !== val && onPick(val) }, label)),
    );
  // Chips: several of a set, each on or off.
  const chips = (options, isOn, onToggle) =>
    h(
      'div',
      { class: 'acd-chips' },
      options.map(([val, label]) => h('label', { class: 'acd-chip' }, h('input', { type: 'checkbox', checked: isOn(val), onChange: (e) => onToggle(val, e.target.checked) }), h('span', null, label))),
    );
  // A setting that is on or off, with one line saying what it does.
  const toggle = (title, desc, checked, onChange, { disabled = false } = {}) =>
    h(
      'label',
      { class: `acd-toggle${disabled ? ' off' : ''}` },
      h('span', { class: 'acd-toggle-text' }, h('b', null, title), h('span', null, desc)),
      h('input', { type: 'checkbox', role: 'switch', checked: checked && !disabled, disabled, onChange: (e) => onChange(e.target.checked) }),
      h('span', { class: 'acd-sw', 'aria-hidden': 'true' }),
    );
  const row = (title, hint, control) => h('div', { class: 'acd-row' }, h('div', { class: 'acd-label' }, h('b', null, title), hint && h('span', null, hint)), control);
  const section = (title, ...rows) => h('section', { class: 'acd-section' }, h('h3', null, title), ...rows);
  const toggleIn = (list, val, on) => (on ? [...new Set([...list, val])] : list.filter((x) => norm(x) !== norm(val)));

  // Tasks ---------------------------------------------------------------------
  const openLink = (key) => h('a', { class: 'key', href: '#' + key, title: `Open ${key}`, onClick: (e) => (e.preventDefault(), e.stopPropagation(), dlg.close(), openDetail(key)) }, key);
  // Worth a second look before Claude takes a task: carried over from earlier sprints, its epic already done.
  const flags = (i) => {
    const closed = (i.sprints || []).filter((sp) => sp.state === 'closed');
    const epic = i.parent && /epic/i.test(i.parent.type || '') ? i.parent : null;
    return [
      closed.length > 0 && h('span', { class: 'acd-flag', title: `Also in ${closed.map((sp) => sp.name).join(', ')}` }, `carried over ×${closed.length}`),
      epic && stageOf(epic.status) === 'done' && h('span', { class: 'acd-flag', title: `${epic.key} is done` }, 'epic done'),
    ];
  };
  const tick = (i, next) =>
    h(
      'label',
      { class: `acd-issue pick${i.ticked ? '' : ' off'}` },
      h('input', { type: 'checkbox', checked: i.ticked, 'aria-label': `Let Auto Claude take ${i.key}`, onChange: (e) => acPost({ tick: { key: i.key, on: e.target.checked } }).then(draw) }),
      typeBadge(i.type),
      openLink(i.key),
      h('span', { class: 'acd-sum', title: i.summary }, i.summary),
      flags(i),
      next && h('span', { class: 'acd-tag' }, 'next'),
    );

  function draw(view = acView) {
    if (!view) return;
    const on = view.on;
    const list = view.candidates;
    const ticked = list.filter((i) => i.ticked);
    const curIssue = view.current && (state.issues.find((i) => i.key === view.current) || { key: view.current, summary: '', type: { name: '' } });

    const status = h(
      'div',
      { class: 'acd-status' },
      h('button', { type: 'button', class: `ac-switch lg${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), 'aria-label': 'Auto Claude', onClick: () => acPost({ on: !on }).then(draw) }, h('span', { class: 'ac-knob' })),
      h(
        'div',
        { class: 'acd-status-text' },
        h('b', null, on ? (view.current ? `Working on ${view.current}` : 'On — waiting for a task') : 'Off'),
        h(
          'span',
          null,
          on
            ? `Checks Jira every minute, also for newly assigned tasks. The next one opens once the current task is ${cfg.advance === 'qa' ? 'dev done (review / test)' : 'started'}.`
            : 'Turn on to open the first ticked task in Claude Code. Runs on the server: no need to keep this page open.',
        ),
      ),
      h('span', { class: 'acd-count' }, `${ticked.length} in queue`),
    );

    const current =
      curIssue &&
      h(
        'div',
        { class: 'acd-current' },
        h(
          'div',
          { class: 'acd-issue' },
          typeBadge(curIssue.type?.name),
          openLink(curIssue.key),
          h('span', { class: 'acd-sum', title: curIssue.summary }, curIssue.summary),
          curIssue.status && h('span', { class: 'acd-tag' }, curIssue.status.name),
        ),
        h(
          'div',
          { class: 'acd-current-acts' },
          h('span', { class: 'muted small' }, view.startedAt ? `Opened ${rel(view.startedAt)}` : ''),
          h('span', { class: 'spacer' }),
          actBtn('Open again', () => acPost({ reopen: true }).then(draw), { iconName: 'ai' }),
          actBtn('Skip', () => acPost({ skip: true }).then(draw), { title: 'Leave this task and take the next one' }),
        ),
      );

    const picks = list.length
      ? h(
          'div',
          { class: 'acd-picks' },
          h(
            'div',
            { class: 'acd-picks-head' },
            h('b', null, `${ticked.length} of ${list.length} selected`),
            h('span', { class: 'spacer' }),
            h('button', { type: 'button', class: 'link-btn small', onClick: () => acPost({ tick: { all: list.map((i) => i.key), on: true } }).then(draw) }, 'All'),
            h('button', { type: 'button', class: 'link-btn small', onClick: () => acPost({ tick: { all: list.map((i) => i.key), on: false } }).then(draw) }, 'None'),
          ),
          h('div', { class: 'acd-list' }, list.map((i) => tick(i, !view.current && i === ticked[0]))),
        )
      : h('div', { class: 'acd-empty' }, view.error ? `Could not read Jira: ${view.error}` : 'No To Do task matches these settings right now.');

    const typeNames = [...list.map((i) => i.type), ...cfg.types].filter(Boolean).filter((t, n, all) => all.findIndex((x) => norm(x) === norm(t)) === n);
    const activity =
      view.log?.length > 0 &&
      h(
        'details',
        { class: 'acd-log' },
        h('summary', null, 'Activity'),
        h('ul', null, view.log.map((l) => h('li', null, h('span', { class: 'muted' }, rel(l.at)), ' ', l.text))),
      );

    body.replaceChildren(
      ...[
        status,
        current,
        picks,
        (view.done > 0 || view.skipped > 0) &&
          h('button', { type: 'button', class: 'link-btn small acd-reset', onClick: () => acPost({ forget: true }).then(draw) }, `Forget ${view.done} done and ${view.skipped} skipped — they can be taken again`),
        section(
          'Tasks',
          row('Types', null, chips(typeNames.map((t) => [t, t]), (t) => cfg.types.some((x) => norm(x) === norm(t)), (t, on2) => saveCfg({ types: toggleIn(cfg.types, t, on2) }))),
        ),
        section(
          'Claude',
          row('Does', null, seg([['implement', 'Code + MR'], ['plan', 'Plan only']], cfg.mode, (val) => saveCfg({ mode: val }))),
          cfg.mode !== 'plan' &&
            h(
              'div',
              { class: 'acd-group' },
              row('Open MRs', 'one per target', chips(Object.keys(MR_KIND_LABELS).map((k) => [k, MR_KIND_LABELS[k]()]), (k) => cfg.mrKinds.includes(k), (k, on2) => saveCfg({ mrKinds: toggleIn(cfg.mrKinds, k, on2) }))),
              toggle('Draft MRs', 'You review, then take them out of draft.', cfg.draft, (x) => saveCfg({ draft: x })),
              toggle('Move the Jira status', 'To In Development when Claude starts.', cfg.moveStatus, (x) => saveCfg({ moveStatus: x })),
              toggle(
                'Dashboard git steps',
                CFG.agent?.writes ? 'Claude branches, commits, pushes and opens MRs through the dashboard tools.' : 'Off in Settings → MCP: Claude runs git itself.',
                cfg.writes,
                (x) => saveCfg({ writes: x }),
                { disabled: !CFG.agent?.writes },
              ),
            ),
        ),
        section(
          'Queue',
          row('Next task when the current one is', null, seg([['qa', 'Dev done'], ['dev', 'Started']], cfg.advance, (val) => saveCfg({ advance: val }))),
          row('Notes', 'sent with every task', h('textarea', { class: 'gin acd-notes', rows: '2', placeholder: 'Sent with every task — conventions, what to skip, how to test…', onChange: (e) => saveCfg({ notes: e.target.value.trim() }) }, cfg.notes)),
        ),
        activity,
        // Settings save as they change; the footer is about running it: Start (off) or Stop / Close (on).
        h(
          'div',
          { class: 'acd-foot' },
          h('span', { class: 'muted small' }, on ? 'Settings are saved as you change them.' : 'Settings are saved as you change them. Each task opens in a Claude Code tab in Cursor — press Enter there.'),
          h('span', { class: 'spacer' }),
          on
            ? [actBtn('Stop', () => acPost({ on: false }).then(() => (toast('Auto Claude stopped'), dlg.close())), { danger: true, title: 'Stop taking tasks (the one in Claude keeps going)' }), actBtn('Close', () => dlg.close(), { primary: true })]
            : [
                actBtn('Cancel', () => dlg.close()),
                actBtn(
                  'Start',
                  () =>
                    acPost({ on: true }).then((nv) => {
                      dlg.close();
                      toast(nv?.current ? `Auto Claude started — opening ${nv.current} in Claude Code` : 'Auto Claude started — waiting for a To Do task (checks every minute)');
                    }),
                  { primary: true, iconName: 'play', title: ticked.length ? `Open ${ticked[0].key} in Claude Code, then the next ones one by one` : 'No ticked task yet: it waits for one' },
                ),
              ],
        ),
      ].filter(Boolean),
    );
  }
  draw(v);
}

// The header follows the server (a task taken while the page is open): look again every 30 s on the Tasks page.
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('auto-claude-slot')) return;
  acLoad();
  clearInterval(acPoll);
  acPoll = setInterval(() => document.visibilityState === 'visible' && acLoad(), 30_000);
});
