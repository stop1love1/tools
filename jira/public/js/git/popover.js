'use strict';

// Popconfirm / prompt (instead of the browser's confirm() and prompt()).

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
