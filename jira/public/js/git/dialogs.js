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
      h('div', { class: 'gmodal-actions' }, h('span', { class: 'muted small' }, 'Format: ', code(`${KEY()}-123: description`), ' — no Co-authored-by.'), h('span', { class: 'spacer' }), actBtn('Commit', submit, { primary: true })),
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
