'use strict';

// Daily report: a dialog with the report for the team chat, filled in from Jira (GET /api/daily-report), editable,
// with Copy and "Copy & open Teams". Opened from the header button, by the desktop notification at the reminder time
// (the server schedules it, lib/daily-notifier.js: the desktop app's own notification, or an OS one that opens
// #daily-report in the browser), or by #daily-report in the URL. Its Settings tab holds everything about the
// report: the template, which tickets go in, and the reminder (config fields marked dialog: 'daily').

CFG.daily ??= { enabled: true, time: '17:00', days: [1, 2, 3, 4, 5], teamsUrl: 'https://teams.live.com/v2/' };

// The report as HTML, from the same parts as the text (daily-template.js composeDailyText): each ticket is a list
// item (its lines kept inside it), and every ticket key (VLEARN-123) is a link to Jira. Teams keeps lists and links
// when rich text is pasted.
function dailyReportHtml({ texts, sections }, site) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) => esc(s).replace(/\b[A-Z][A-Z0-9_]+-\d+\b/g, (key) => `<a href="${esc(site)}/browse/${key}">${key}</a>`);
  const parts = []; // text lines, and lists
  const add = (text) => text != null && parts.push(...text.split('\n'));
  texts.forEach((text, i) => {
    if (i) {
      const { items, empty } = sections[i - 1];
      if (items.length) parts.push({ list: `<ul>${items.map((t) => `<li>${t.split('\n').map(inline).join('<br>')}</li>`).join('')}</ul>` });
      else add(empty);
    }
    add(text);
  });
  while (parts.length && typeof parts.at(-1) === 'string' && !parts.at(-1).trim()) parts.pop();
  // Text lines are joined with <br>; a list needs none around it, and its own spacing replaces a blank line after it.
  let html = '';
  parts.forEach((part, k) => {
    if (part.list) return (html += part.list);
    if (part === '' && parts[k - 1]?.list) return;
    html += inline(part) + (k < parts.length - 1 && !parts[k + 1].list ? '<br>' : '');
  });
  return `<div>${html}</div>`;
}

// Rich text (links) + plain text on the clipboard; plain text only where rich copy is not available.
async function copyDailyReport(report, site) {
  const text = composeDailyText(report);
  const message = 'Daily report copied with Jira links — paste it into Teams';
  try {
    if (!site || typeof ClipboardItem === 'undefined') throw new Error('no rich clipboard');
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([dailyReportHtml(report, site)], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    toast(message);
  } catch {
    await copyText(text, 'Daily report copied (plain text, without links)');
  }
}

// The dialog: a checklist, one row per ticket (tick box + editable line). Only ticked rows are copied.
let dailyDialog = null; // the open dialog: { show(tab) }
async function openDailyReport({ mine = false, tab = 'report' } = {}) {
  if (dailyDialog) return dailyDialog.show(tab);
  const user = mine ? '' : dailyWho();
  const whoName = user ? dailyWhoName() : 'you';
  const info = h('div', { class: 'muted small daily-info', role: 'status' });
  // The template's own text around the two lists ({date} filled in), each editable. null = no line there.
  const textBox = (label) => {
    const ta = h('textarea', { class: 'gin daily-text', spellcheck: 'false', 'aria-label': label, hidden: true });
    const fit = () => (ta.rows = Math.max(1, ta.value.split('\n').length));
    ta.addEventListener('input', fit);
    return Object.assign(ta, { _fit: fit, _orig: null });
  };
  const texts = [textBox('Text before the first list'), textBox('Text between the lists'), textBox('Text after the lists')];
  // Unchanged: as the template has it. Cleared: no line there.
  const textOf = (ta) => (ta.value === (ta._orig ?? '') ? ta._orig : ta.value.trim() ? ta.value.replace(/\s+$/, '') : null);
  const SECTIONS = {
    handed: { hint: 'moved today to Ready for SIT / UAT or later, or done' },
    pending: { hint: 'in progress, selftest, in review' },
  };
  // In the template's order (load() sets it).
  let sections = Object.entries(SECTIONS).map(([id, sec]) => ({ id, ...sec, empty: null, list: h('div', { class: 'daily-list' }), count: h('span', { class: 'muted small' }) }));
  let site = '';

  const rowsOf = (sec) => [...sec.list.querySelectorAll('.daily-item')];
  // A ticket's text without its blank lines.
  const tidy = (text) => text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).join('\n');
  const picked = (sec) => rowsOf(sec).filter((r) => r.querySelector('input[type=checkbox]').checked).map((r) => tidy(r.querySelector('.daily-line').value)).filter(Boolean);
  const report = () => ({ texts: texts.map(textOf), sections: sections.map((sec) => ({ items: picked(sec), empty: sec.empty })) });
  const refresh = () => {
    let total = 0;
    for (const sec of sections) {
      const rows = rowsOf(sec);
      const n = picked(sec).length;
      total += n;
      sec.count.textContent = rows.length ? `${n} / ${rows.length} ticked` : 'none';
      for (const r of rows) r.classList.toggle('off', !r.querySelector('input[type=checkbox]').checked);
    }
    info.textContent = `${total} ticket${total === 1 ? '' : 's'} will be copied. Ticket keys paste into Teams as links to Jira, each ticket as a list item.`;
  };

  // Drag and drop: a row is dragged by its grip, within its section or into the other one. The grip also moves it
  // with the keyboard (↑ / ↓, across sections at the edges).
  let dragged = null;
  const sectionOfRow = (el) => sections.find((s) => s.list === el.parentElement);
  // A ticket line moved to another section takes that section's format, unless it was edited by hand.
  const moved = (el, from) => {
    const to = sectionOfRow(el);
    const input = el.querySelector('.daily-line');
    if (to && from && to !== from && el._lines && input.value === el._lines[from.id]) (input.value = el._lines[to.id]), el._fit();
    refresh();
  };
  const rowAfter = (list, y) =>
    rowsOf({ list }).find((r) => r !== dragged && y < r.getBoundingClientRect().top + r.offsetHeight / 2) || null;
  function dropTarget(sec, el) {
    el.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const next = rowAfter(sec.list, e.clientY);
      if (dragged.nextSibling !== next || dragged.parentElement !== sec.list) sec.list.insertBefore(dragged, next);
    });
    el.addEventListener('drop', (e) => dragged && e.preventDefault());
  }

  // "+ Add line" suggestions: my stories / bugs from the server (candidates), minus those already in the dialog.
  // Typing filters them by key or title; picking one fills the line in the section's format.
  let candidates = [];
  const suggest = { menu: null, items: [], active: 0, input: null };
  const closeSuggest = () => {
    suggest.menu?.remove();
    Object.assign(suggest, { menu: null, items: [], active: 0, input: null });
  };
  function openSuggest(el, input) {
    const listed = new Set(sections.flatMap(rowsOf).map((r) => r._key).filter(Boolean));
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const items = candidates
      .filter((t) => !listed.has(t.key))
      .filter((t) => words.every((w) => `${t.key} ${t.summary} ${t.status}`.toLowerCase().includes(w)))
      .slice(0, 8);
    if (!items.length) return closeSuggest();
    if (suggest.input !== input) closeSuggest();
    suggest.menu ??= h('div', { class: 'daily-suggest', role: 'listbox', 'aria-label': 'Your stories and bugs' });
    Object.assign(suggest, { items, input, active: Math.min(suggest.active, items.length - 1) });
    const pick = (t) => {
      const sec = sectionOfRow(el);
      el._setTicket(t, sec?.id || 'pending');
      closeSuggest();
      refresh();
    };
    suggest.menu.replaceChildren(
      ...items.map((t, i) =>
        h(
          'div',
          { class: `daily-suggest-item${i === suggest.active ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === suggest.active), onMousedown: (e) => (e.preventDefault(), pick(t)) },
          h('b', null, t.key),
          h('span', { class: 'daily-suggest-title' }, t.summary),
          h('span', { class: 'muted small' }, t.status),
        ),
      ),
    );
    suggest.pick = () => pick(items[suggest.active]);
    // Fixed to the viewport: the dialog body scrolls and would clip it.
    const r = input.getBoundingClientRect();
    const below = innerHeight - r.bottom > 260 || r.top < 260;
    Object.assign(suggest.menu.style, { left: `${r.left}px`, width: `${r.width}px`, top: below ? `${r.bottom + 4}px` : '', bottom: below ? '' : `${innerHeight - r.top + 4}px` });
    if (!suggest.menu.isConnected) modal.append(suggest.menu);
  }

  function row(line, { checked = true, key = '', lines = null } = {}) {
    const box = h('input', { type: 'checkbox', 'aria-label': `Include ${key || 'this line'}` });
    box.checked = checked;
    // A ticket can take several lines (the template's), so it is a textarea as tall as its text.
    const input = h('textarea', { class: 'gin daily-line', spellcheck: 'false', autocomplete: 'off', 'aria-label': key ? `${key} text` : 'Text' });
    input.value = line;
    const fit = () => (input.rows = input.value.split('\n').length);
    fit();
    const del = h('button', { class: 'icon-btn sm', title: 'Remove this line', 'aria-label': 'Remove this line', onClick: () => (el.remove(), refresh()) }, icon('trash'));
    const grip = h('button', { class: 'icon-btn sm daily-grip', title: 'Drag to move (or ↑ / ↓)', 'aria-label': `Move ${key || 'this line'}` }, icon('grip'));
    const link = h('a', { class: 'icon-btn sm', target: '_blank', rel: 'noopener' }, icon('ext'));
    const el = h('div', { class: 'daily-item' }, grip, box, input, link, del);
    const setKey = (k) => {
      el._key = k;
      link.hidden = !k;
      if (k) Object.assign(link, { href: `${site}/browse/${k}`, title: `Open ${k} in Jira` }), link.setAttribute('aria-label', `Open ${k} in Jira`);
    };
    setKey(key);
    el._lines = lines;
    el._fit = fit;
    el._setTicket = (t, sectionId) => {
      setKey(t.key);
      el._lines = t.lines;
      input.value = t.lines?.[sectionId] || t.line;
      fit();
      box.checked = true;
    };
    // A line typed by hand (no ticket yet) suggests my stories / bugs as you type.
    input.addEventListener('focus', () => !el._key && openSuggest(el, input));
    input.addEventListener('input', () => (el._key ? null : openSuggest(el, input)));
    input.addEventListener('blur', () => suggest.input === input && closeSuggest());
    input.addEventListener('keydown', (e) => {
      if (suggest.input !== input) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        suggest.active = (suggest.active + (e.key === 'ArrowDown' ? 1 : -1) + suggest.items.length) % suggest.items.length;
        openSuggest(el, input);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.key === 'Enter' || input.value.trim()) e.preventDefault(), suggest.pick();
      }
    });
    // Only the grip starts a drag, so text in the line can still be selected with the mouse.
    let from = null;
    grip.addEventListener('pointerdown', () => (el.draggable = true));
    el.addEventListener('dragstart', (e) => {
      if (!el.draggable) return e.preventDefault();
      dragged = el;
      from = sectionOfRow(el);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', input.value);
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    el.addEventListener('dragend', () => {
      el.draggable = false;
      el.classList.remove('dragging');
      dragged = null;
      moved(el, from);
    });
    grip.addEventListener('pointerup', () => (el.draggable = false));
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const src = sectionOfRow(el);
      const up = e.key === 'ArrowUp';
      const sib = up ? el.previousElementSibling : el.nextElementSibling;
      if (sib) up ? sib.before(el) : sib.after(el);
      else {
        const other = sections[sections.indexOf(src) + (up ? -1 : 1)];
        if (!other) return;
        up ? other.list.append(el) : other.list.prepend(el);
      }
      moved(el, src);
      grip.focus();
    });
    box.addEventListener('change', refresh);
    input.addEventListener('input', () => (fit(), refresh()));
    // Typing in a line ticks it: an edited line is one you want to send.
    input.addEventListener('input', () => {
      if (!box.checked) (box.checked = true), refresh();
    });
    return el;
  }

  const close = () => {
    closeSuggest();
    dailyDialog = null;
    modal.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      // Esc closes the suggestions first, then the dialog.
      if (suggest.menu) closeSuggest();
      else close();
    }
  };
  const copy = () => copyDailyReport(report(), site);
  const copyBtn = h('button', { class: 'btn', onClick: copy }, icon('copy'), 'Copy');
  const teamsBtn = h(
    'button',
    {
      class: 'btn primary',
      onClick: async () => {
        await copy();
        window.open(CFG.daily.teamsUrl || 'https://teams.live.com/v2/', '_blank', 'noopener');
      },
    },
    icon('ext'),
    'Copy & open Teams',
  );
  const regen = h('button', { class: 'btn', title: 'Build it again from Jira (your edits are lost)', onClick: () => load() }, icon('refresh'), 'Rebuild');
  const sectionEl = (sec) => {
    const el = h(
      'section',
      { class: 'daily-section' },
      h('div', { class: 'daily-section-head' }, h('b', null, DAILY_SECTIONS[sec.id]), h('span', { class: 'muted small' }, sec.hint), h('span', { class: 'spacer' }), sec.count),
      sec.list,
      h('button', { class: 'link-btn small daily-add', onClick: () => {
        const r = row('', { checked: true });
        sec.list.append(r);
        r.querySelector('.daily-line').focus();
        refresh();
      } }, '+ Add line'),
    );
    // The whole section takes a drop, so an empty section can still receive a row.
    dropTarget(sec, el);
    return el;
  };
  const body = h('div', { class: 'daily-body' });
  // Text, list, text, list, text: as the template lays them out.
  const layoutBody = () => body.replaceChildren(texts[0], sectionEl(sections[0]), texts[1], sectionEl(sections[1]), texts[2]);
  layoutBody();
  // The suggestions are fixed to the viewport: scrolling the body would leave them behind.
  body.addEventListener('scroll', closeSuggest);

  async function load() {
    copyBtn.disabled = teamsBtn.disabled = regen.disabled = true;
    body.classList.add('loading');
    info.textContent = 'Reading your tasks from Jira…';
    try {
      const r = await api(`/api/daily-report${user ? `?user=${encodeURIComponent(user)}` : ''}`);
      site = r.site || '';
      candidates = r.candidates || [];
      // A server started before an update still answers in the old shape: say so rather than fail on it.
      if (!r.layout) throw new Error('the server is older than this page: restart it (npm start, or reopen the app)');
      const order = r.layout.sections.map((x) => x.id);
      sections = order.map((id) => sections.find((sec) => sec.id === id));
      r.layout.sections.forEach((x, i) => (sections[i].empty = x.empty));
      texts.forEach((ta, i) => {
        ta._orig = r.layout.texts[i];
        ta.value = r.layout.texts[i] ?? '';
        ta.hidden = r.layout.texts[i] == null;
        ta._fit();
      });
      layoutBody();
      const rowsFor = (list) => list.map((t) => row(t.line, { key: t.key, lines: t.lines }));
      sections.find((sec) => sec.id === 'handed').list.replaceChildren(...rowsFor(r.handedOver));
      sections.find((sec) => sec.id === 'pending').list.replaceChildren(...rowsFor(r.pending));
      copyBtn.disabled = teamsBtn.disabled = false;
      refresh();
    } catch (e) {
      info.textContent = `Could not build the report: ${e.message}`;
    } finally {
      body.classList.remove('loading');
      regen.disabled = false;
    }
  }

  // Tabs: the report, and its settings (template, tickets, reminder). A save rebuilds the report with them.
  const reportActions = h('div', { class: 'daily-actions' }, regen, h('span', { class: 'spacer' }), copyBtn, teamsBtn);
  const settings = dailySettingsPane({ onSaved: () => (stale = true) });
  let stale = false;
  const tabs = [
    { id: 'report', label: 'Report', panes: [body, info, reportActions] },
    { id: 'settings', label: 'Settings', panes: [settings.el, settings.bar] },
  ];
  const show = (id) => {
    closeSuggest();
    for (const t of tabs) {
      t.btn.setAttribute('aria-selected', String(t.id === id));
      for (const p of t.panes) p.hidden = t.id !== id;
    }
    if (id === 'settings') settings.load();
    else if (stale) (stale = false), load();
  };
  for (const t of tabs) t.btn = h('button', { role: 'tab', onClick: () => show(t.id) }, icon(t.id === 'report' ? 'doc' : 'gear'), t.label);

  const modal = h(
    'div',
    { class: 'daily-modal', onClick: (e) => e.target === modal && close() },
    h(
      'div',
      { class: 'daily-content', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Daily report' },
      h(
        'div',
        { class: 'daily-head' },
        h('h2', null, icon('doc'), 'Daily report', h('span', { class: 'muted daily-who' }, `· ${whoName}`)),
        h('div', { class: 'daily-tabs', role: 'tablist' }, tabs.map((t) => t.btn)),
        h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onClick: close }, icon('x')),
      ),
      tabs.flatMap((t) => t.panes),
    ),
  );
  document.addEventListener('keydown', onKey, true);
  document.body.append(modal);
  dailyDialog = { show };
  show(tab);
  await load();
}
window.openDailyReport = openDailyReport;

// Whose report: the person the header's user filter shows ('' = me). All / Unassigned have none.
const dailyWho = () => (typeof state !== 'undefined' ? state.user || '' : '');
const dailyForOne = () => !['__all__', '__unassigned__'].includes(dailyWho());
const dailyWhoName = () => (dailyWho() ? (typeof viewedUserName === 'function' ? viewedUserName() : 'selected user') : 'you');

// Header button (next to the bell): the daily report of the user the filter shows. The reminder (on/off, time,
// days) is in the dialog's Settings tab.
function setupDailyButton() {
  const bell = $('#bell');
  if (!bell) return;
  const btn = h('button', { class: 'icon-btn outline', id: 'daily-btn', onClick: () => openDailyReport() }, icon('doc'));
  const sync = () => {
    const ok = dailyForOne();
    btn.disabled = !ok;
    const label = ok ? `Daily report — ${dailyWhoName()}` : 'Daily report: pick one person in the user filter';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  };
  bell.before(btn);
  sync();
  // The user list loads after the page: names come in late, and the filter changes.
  // After app-shared.js's own change handler has updated state.user.
  $('#user-filter')?.addEventListener('change', () => setTimeout(sync));
  new MutationObserver(sync).observe($('#user-filter') || document.body, { childList: true });
}

// A button that sends the reminder now, the way it will come at the set time (desktop app: its own notification;
// browser: an OS notification that opens the report).
function dailyTestRow() {
  const status = h('span', { class: 'muted small', role: 'status' });
  const btn = h(
    'button',
    {
      class: 'btn sm',
      onClick: async () => {
        btn.disabled = true;
        status.textContent = 'Sending…';
        try {
          const { shownBy } = await api('/api/daily-report/test', { method: 'POST' });
          status.textContent = {
            app: 'Sent: the desktop app shows it in a few seconds.',
            os: 'Sent: check your desktop notifications. Clicking it opens the report.',
            'no-notify-send': 'Could not notify: install libnotify (notify-send).',
            unsupported: 'Desktop notifications from the server work on Linux only.',
          }[shownBy] || `Sent (${shownBy}).`;
        } catch (e) {
          status.textContent = e.message;
        } finally {
          btn.disabled = false;
        }
      },
    },
    icon('bell'),
    'Send a test notification',
  );
  return h(
    'div',
    { class: 'set-row' },
    h('div', { class: 'set-label' }, h('label', null, 'Try it'), h('div', { class: 'muted small' }, 'Uses the saved settings. Works without a dashboard tab open while the server runs.')),
    h('div', { class: 'set-input daily-test' }, btn, status),
  );
}

// The template editor: one textarea for the whole message. {variables} and {#block} lines are highlighted (a
// layer under the transparent textarea, with the same text), chips insert them at the cursor, and a preview shows
// the message with sample tickets as it is typed.
function dailyTemplateInput(value, onChange) {
  const ta = h('textarea', { class: 'daily-tpl-input', spellcheck: 'false', autocomplete: 'off', wrap: 'soft' });
  const marks = h('div', { class: 'daily-tpl-marks', 'aria-hidden': 'true' });
  const problem = h('div', { class: 'set-err', role: 'alert' });
  const preview = h('pre', { class: 'daily-tpl-preview' });
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const known = new Set(Object.keys(DAILY_VARS));
  const SAMPLE_NOW = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${pad(SAMPLE_NOW.getDate())}/${pad(SAMPLE_NOW.getMonth() + 1)}/${SAMPLE_NOW.getFullYear()}`;
  const tomorrow = new Date(SAMPLE_NOW.getTime() + 86400000);
  const SAMPLE = {
    handed: [
      { key: 'VLEARN-1234', title: '[Admin] Màn hình danh sách chứng chỉ', status: 'Ready for SIT', testers: '@Tester A' },
      { key: 'VLEARN-1235', title: '[BE] API xuất báo cáo', status: 'Done', testers: '' },
    ],
    pending: [{ key: 'VLEARN-1240', title: '[Learner] Trang chi tiết chứng chỉ', status: 'In Progress', testers: '@Tester B', expectedDate: `${pad(tomorrow.getDate())}/${pad(tomorrow.getMonth() + 1)}` }],
  };

  const sync = () => {
    const v = ta.value;
    // Block lines, then {variables}: known ones in the accent color, unknown ones flagged.
    marks.innerHTML =
      v
        .split('\n')
        .map((line) =>
          /^\s*\{\s*(#\s*\w+|\/\s*\w+|else)\s*\}\s*$/.test(line)
            ? `<span class="daily-tpl-block">${esc(line)}</span>`
            : esc(line).replace(/\{(\w+)\}/g, (m, n) => `<span class="${known.has(n) ? 'daily-tpl-var' : 'daily-tpl-unknown'}">${m}</span>`),
        )
        .join('\n') + '\n';
    ta.rows = Math.max(8, v.split('\n').length + 1);
    const err = dailyTemplateError(v);
    problem.textContent = err ? `Template: ${err}` : '';
    if (err) return preview.classList.add('stale');
    preview.classList.remove('stale');
    const layout = parseDailyTemplate(v);
    const fixed = dailyFixedParts(layout, { date: today });
    const values = (t) => ({ date: today, expectedTime: CFG.daily.expectedTime || '17:00', expectedDate: t.expectedDate || '', ...t });
    preview.textContent = composeDailyText({
      texts: fixed.texts,
      sections: fixed.sections.map((sec) => ({ ...sec, items: SAMPLE[sec.id].map((t) => dailyTicketText(layout, sec.id, values(t))) })),
    });
  };
  ta.addEventListener('input', () => (sync(), onChange()));
  ta.addEventListener('scroll', () => (marks.scrollTop = ta.scrollTop));

  // Inserts text at the cursor (replacing a selection) and keeps the undo history (execCommand where it works).
  const insert = (text) => {
    ta.focus();
    if (!document.execCommand?.('insertText', false, text)) {
      const { selectionStart: a, selectionEnd: b } = ta;
      ta.setRangeText(text, a, b, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  // A block goes on lines of its own.
  const insertBlock = (id) => {
    const before = ta.value.slice(0, ta.selectionStart);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    insert(`${lead}{#${id}}\n[{key}] {title}\n{else}\nKhông có\n{/${id}}\n`);
  };
  const chip = (label, title, onClick, cls = '') => h('button', { type: 'button', class: `daily-tpl-chip ${cls}`, title, onMousedown: (e) => e.preventDefault(), onClick }, label);
  const chips = h(
    'div',
    { class: 'daily-tpl-chips' },
    Object.entries(DAILY_VARS).map(([name, help]) => chip(`{${name}}`, help, () => insert(`{${name}}`))),
    Object.entries(DAILY_SECTIONS).map(([id, label]) => chip(`+ ${label}`, `Insert a {#${id}} … {/${id}} block: its lines repeat for each ticket, {else} when there is none`, () => insertBlock(id), 'block')),
  );

  const set = (v) => ((ta.value = v), sync());
  set(value);
  return {
    el: h(
      'div',
      { class: 'daily-tpl' },
      chips,
      h('div', { class: 'daily-tpl-edit' }, marks, ta),
      problem,
      h('details', { class: 'daily-tpl-help muted small' }, h('summary', null, 'How it works'),
        h('p', null, 'Text outside a block is sent as written. The lines between {#handed} and {/handed} (or {#pending} … {/pending}) repeat once per ticket, each ticket a bullet; the lines after {else} show when the section has no ticket.'),
        h('p', null, 'An empty value at the end of a line drops the separator before it: no tester → no "➡️". A line whose values are all empty is left out.')),
      h('div', { class: 'daily-tpl-preview-head muted small' }, 'Preview with sample tickets'),
      preview,
    ),
    set,
    read: () => ta.value.replace(/\r\n?/g, '\n').replace(/\s+$/, ''),
  };
}

// The dialog's Settings tab: the config sections marked dialog: 'daily' (lib/config.js SCHEMA), with the Settings
// page's own inputs (settings.js fieldInput) and its save (PUT /api/config).
function dailySettingsPane({ onSaved }) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const el = h('div', { class: 'daily-body daily-settings' });
  const status = h('span', { class: 'muted small', role: 'status' });
  const saveBtn = h('button', { class: 'btn primary', onClick: () => save() }, 'Save');
  const bar = h('div', { class: 'daily-actions' }, status, h('span', { class: 'spacer' }), saveBtn);
  let data = null;
  let inputs = new Map();
  saveBtn.disabled = true;

  const changed = () => [...inputs].filter(([k, f]) => !same(f.read(), data.values[k]));
  const refresh = () => {
    const n = changed().length;
    status.textContent = n ? `${n} unsaved change${n > 1 ? 's' : ''}` : 'Saved settings apply to the next report.';
    saveBtn.disabled = !n;
    for (const [k, f] of inputs) {
      f.row.classList.toggle('changed', !same(f.read(), data.values[k]));
      f.reset.hidden = same(f.read(), data.defaults[k]);
    }
  };

  function build(errors = {}) {
    inputs = new Map();
    let ids = 0;
    el.replaceChildren(
      ...data.schema
        .filter((sec) => sec.dialog === 'daily')
        .map((sec) =>
          h(
            'section',
            { class: 'daily-set-section' },
            h('h3', null, sec.section.replace(/^Daily report: /, '').replace(/^./, (c) => c.toUpperCase())),
            sec.help && h('p', { class: 'muted small' }, sec.help),
            sec.fields.map((f) => {
              const onInput = () => ((err.textContent = ''), refresh());
              const field = f.type === 'template' ? dailyTemplateInput(data.values[f.key], onInput) : fieldInput(f, data.values[f.key], onInput);
              const err = h('div', { class: 'set-err', role: 'alert' }, errors[f.key] || '');
              const reset = h('button', { class: 'link-btn small', 'aria-label': `Reset ${f.label} to default`, onClick: () => (field.set(data.defaults[f.key]), refresh()) }, 'Reset to default');
              const label = h('label', null, f.label);
              const control = field.el.matches('input, textarea') ? field.el : field.el.querySelector('input[type=checkbox]');
              if (control && f.type !== 'weekdays') (control.id = `daily-set-${++ids}`), label.setAttribute('for', control.id);
              const row = h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, label, f.help && h('div', { class: 'muted small' }, f.help)), h('div', { class: 'set-input' }, field.el, err, reset));
              inputs.set(f.key, { ...field, row, reset, err });
              return row;
            }),
            sec.section.endsWith('reminder') && dailyTestRow(),
          ),
        ),
    );
    refresh();
  }

  async function load() {
    if (data) return;
    status.textContent = 'Loading settings…';
    try {
      data = await api('/api/config');
      build();
    } catch (e) {
      status.textContent = `Could not load the settings: ${e.message}`;
    }
  }

  async function save() {
    const values = Object.fromEntries(changed().map(([k, f]) => [k, f.read()]));
    if (!Object.keys(values).length) return;
    saveBtn.disabled = true;
    try {
      data = await api('/api/config', { method: 'PUT', body: JSON.stringify({ values }) });
      applyClientConfig(data.client);
      // The Settings page, if this is it, shows the saved values too.
      if (typeof settingsState !== 'undefined' && settingsState.data) settingsState.data = data;
      build();
      onSaved();
      toast('Daily report settings saved');
    } catch (e) {
      toast(e.message, 'error');
      for (const [k, f] of inputs) f.err.textContent = e.fields?.[k] || '';
      refresh();
    }
  }

  return { el, bar, load };
}

function setupDailyReport() {
  setupDailyButton();
  // From the reminder notification: always my own report, whoever the filter shows.
  window.electron?.daily?.onOpen(() => openDailyReport({ mine: true }));
  if (location.hash === '#daily-report') {
    history.replaceState(null, '', location.pathname + location.search);
    openDailyReport({ mine: true });
  }
}
