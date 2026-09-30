'use strict';

// Modal dialogs: commit, job log.

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
  const msg = h('textarea', { class: 'gin mono', rows: '3', spellcheck: 'true', placeholder: `${ticket || `${KEY()}-XXXX`}: <what changed, in English>` });
  // The message survives a rejected commit (bad format, failing hook) until one on this branch succeeds.
  const draft = LS.get('commitDraft', {})[repo];
  msg.value = draft?.branch === main.branch && draft.text ? draft.text : ticket ? `${ticket}: ` : '';
  const saveDraft = (text) => LS.set('commitDraft', { ...LS.get('commitDraft', {}), [repo]: text == null ? undefined : { branch: main.branch, text } });
  msg.addEventListener('input', () => saveDraft(msg.value));
  const err = h('div', { class: 'gpop-err', hidden: true });
  msg.addEventListener('input', () => (err.hidden = true));
  const XY = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'untracked', U: 'conflict' };
  const status = (xy) => (xy === '??' ? '?' : xy[1] !== '.' ? xy[1] : xy[0]);
  const all = h('input', { type: 'checkbox', checked: true, onChange: (e) => boxes.forEach((b) => (b.checked = e.target.checked)) });
  // Task branches are the user's own: pushing right after the commit saves a round trip (remembered).
  const task = CFG.git.branchTypes.some((t) => (main.branch || '').startsWith(t + '/'));
  const pushBox = h('input', { type: 'checkbox', checked: LS.get('commitPush', true) });
  // Same rules as the server, checked before the dialog closes.
  const problem = (text) =>
    !new RegExp(`^${KEY()}-\\d+: \\S`).test(text)
      ? `Expected "${ticket || `${KEY()}-123`}: <what changed, in English>".`
      : ticket && !text.startsWith(`${ticket}:`)
        ? `Branch ${main.branch} needs messages starting with "${ticket}: ".`
        : '';
  const submit = async () => {
    const text = msg.value.trim();
    const files = boxes.filter((b) => b.checked).map((b) => b.value);
    if (!files.length) return toast('No file selected', 'error');
    const bad = problem(text);
    if (bad) {
      err.textContent = bad;
      err.hidden = false;
      return msg.focus();
    }
    saveDraft(text);
    if (task) LS.set('commitPush', pushBox.checked);
    dlg.close();
    const job = await gitAction({ action: 'commit', repo, message: text, files, push: task && pushBox.checked });
    if (job?.status === 'ok' || job?.error?.startsWith('Committed,')) saveDraft(null);
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
      err,
      h('div', { class: 'gmodal-actions' }, h('span', { class: 'muted small' }, 'Format: ', code(`${KEY()}-123: description`), ' — no Co-authored-by.'), h('span', { class: 'spacer' }), task && h('label', { class: 'gcheck-all small' }, pushBox, 'Push after commit'), actBtn('Commit', submit, { primary: true })),
    ),
  );
  msg.focus();
  msg.addEventListener('keydown', (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit());
}

// Live log of a git job; offers conflict actions when it stops on one. `started`: the job was just launched from here,
// so on success it redraws git state and closes; a finished job opened from the list stays open to be read.
async function showJob(id, { started = false } = {}) {
  const status = h('span', { class: 'gchip' }, 'running');
  const log = h('pre', { class: 'glog' });
  const extra = h('div');
  const dlg = modal('Git', h('div', { class: 'gmodal-body' }, h('div', { class: 'gjob-head' }, status), log, extra));
  const title = $('h2', dlg.el);
  let watched = started;
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
      watched = true;
      // Closed while running: the job keeps going on the server; keep polling quietly for the result.
      await new Promise((r) => setTimeout(r, dlg.el.isConnected ? 700 : 1500));
      continue;
    }
    if (watched) {
      refreshGit();
      // Success: the log goes away (still under Workspace → Recent git jobs); the drawer now shows the next step.
      if (job.status === 'ok') {
        toast(job.result?.branch ? `Ready: ${job.result.branch} (${job.result.repos.join(', ')})` : `${job.title}: done`);
        setTimeout(dlg.close, 1200);
      }
    }
    if (job.status === 'error') extra.replaceChildren(h('div', { class: 'error-box' }, job.error));
    if (job.status === 'conflict') {
      const c = job.result;
      extra.replaceChildren(
        h(
          'div',
          { class: 'gconflict' },
          h('div', null, h('b', null, `${c.op} stopped on a conflict`), ' in ', code(c.dir)),
          c.files?.length > 0 && h('ul', { class: 'gfiles' }, c.files.map((f) => h('li', { class: 'mono' }, f))),
          h('div', { class: 'muted small' }, 'Resolve the files in the editor (remove the conflict markers), then Continue — it finishes the step, push included. A backup was taken before — Undo restores it.'),
          h('div', { class: 'gstep-act' }, conflictActions(job.repo, c.dir, c.op)),
        ),
      );
    }
    return job;
  }
}
