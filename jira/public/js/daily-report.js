'use strict';

// Daily report: a dialog with the report for the team chat, filled in from Jira (GET /api/daily-report), editable,
// with Copy and "Copy & open Teams". Opened from the ⋯ menu, by the desktop notification at the reminder time
// (the server schedules it, lib/daily-notifier.js: the desktop app's own notification, or an OS one that opens
// #daily-report in the browser), or by #daily-report in the URL. The reminder's on/off switch, time and days are
// in Settings → Daily report.

CFG.daily ??= { enabled: true, time: '17:00', days: [1, 2, 3, 4, 5], teamsUrl: 'https://teams.live.com/v2/' };

// The report as HTML: "• " lines (one per ticket) become a bulleted list, other lines keep their breaks, and every
// ticket key (VLEARN-123) is a link to Jira. Teams keeps lists and links when rich text is pasted.
const DAILY_BULLET = /^\s*•\s*/; // list items; "- Đã bàn giao:" lines are headings, not items
function dailyReportHtml(text, site) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) => esc(s).replace(/\b[A-Z][A-Z0-9_]+-\d+\b/g, (key) => `<a href="${esc(site)}/browse/${key}">${key}</a>`);
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (DAILY_BULLET.test(lines[i])) {
      const items = [];
      while (i < lines.length && DAILY_BULLET.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(DAILY_BULLET, ''))}</li>`);
      i--;
      while (out.length && out.at(-1) === '') out.pop(); // the list's own spacing replaces blank lines around it
      out.push({ list: `<ul>${items.join('')}</ul>` });
    } else if (!(lines[i] === '' && out.at(-1)?.list)) {
      out.push(lines[i] === '' ? '' : inline(lines[i]));
    }
  }
  // Text lines are joined with <br>; a list needs none around it.
  let html = '';
  out.forEach((part, k) => {
    if (part.list) html += part.list;
    else html += part + (k < out.length - 1 && !out[k + 1].list ? '<br>' : '');
  });
  return `<div>${html}</div>`;
}

// Rich text (links) + plain text on the clipboard; plain text only where rich copy is not available.
async function copyDailyReport(text, site) {
  const message = 'Daily report copied with Jira links — paste it into Teams';
  try {
    if (!site || typeof ClipboardItem === 'undefined') throw new Error('no rich clipboard');
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([dailyReportHtml(text, site)], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    toast(message);
  } catch {
    await copyText(text, 'Daily report copied (plain text, without links)');
  }
}

// The report from what is ticked: same layout as the server's (lib/daily-report.js composeReport). A section with
// nothing ticked reads ": 0".
function composeDailyReport(heading, handed, pending) {
  const lines = [heading];
  if (handed.length) lines.push('- Đã bàn giao:', '', ...handed.map((l) => `• ${l}`), '');
  else lines.push('- Đã bàn giao: 0');
  if (pending.length) lines.push('- Đã làm nhưng chưa bàn giao:', '', ...pending.map((l) => `• ${l}`));
  else lines.push('- Đã làm nhưng chưa bàn giao: 0');
  return lines.join('\n');
}

// The dialog: a checklist, one row per ticket (tick box + editable line). Only ticked rows are copied.
async function openDailyReport({ mine = false } = {}) {
  if ($('.daily-modal')) return $('.daily-heading')?.focus();
  const user = mine ? '' : dailyWho();
  const whoName = user ? dailyWhoName() : 'you';
  const info = h('div', { class: 'muted small daily-info', role: 'status' });
  const headingIn = h('input', { class: 'gin daily-heading', 'aria-label': 'Report heading', spellcheck: 'false' });
  const sections = [
    { id: 'handed', label: 'Đã bàn giao', hint: 'status you moved today to a tester, or done' },
    { id: 'pending', label: 'Đã làm nhưng chưa bàn giao', hint: 'in progress, in review, waiting for SIT' },
  ].map((sec) => ({ ...sec, list: h('div', { class: 'daily-list' }), count: h('span', { class: 'muted small' }) }));
  let site = '';

  const rowsOf = (sec) => [...sec.list.querySelectorAll('.daily-item')];
  const picked = (sec) => rowsOf(sec).filter((r) => r.querySelector('input[type=checkbox]').checked).map((r) => r.querySelector('.daily-line').value.trim()).filter(Boolean);
  const reportText = () => composeDailyReport(headingIn.value.trim(), picked(sections[0]), picked(sections[1]));
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

  function row(line, { checked = true, key = '' } = {}) {
    const box = h('input', { type: 'checkbox', 'aria-label': `Include ${key || 'this line'}` });
    box.checked = checked;
    const input = h('input', { class: 'gin daily-line', value: line, spellcheck: 'false', 'aria-label': key ? `${key} line` : 'Line' });
    const del = h('button', { class: 'icon-btn sm', title: 'Remove this line', 'aria-label': 'Remove this line', onClick: () => (el.remove(), refresh()) }, icon('trash'));
    const el = h('div', { class: 'daily-item' }, box, input, key && h('a', { class: 'icon-btn sm', href: `${site}/browse/${key}`, target: '_blank', rel: 'noopener', title: `Open ${key} in Jira`, 'aria-label': `Open ${key} in Jira` }, icon('ext')), del);
    box.addEventListener('change', refresh);
    input.addEventListener('input', refresh);
    // Typing in a line ticks it: an edited line is one you want to send.
    input.addEventListener('input', () => {
      if (!box.checked) (box.checked = true), refresh();
    });
    return el;
  }

  const close = () => {
    modal.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const copy = () => copyDailyReport(reportText(), site);
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
  const body = h(
    'div',
    { class: 'daily-body' },
    headingIn,
    sections.map((sec) =>
      h(
        'section',
        { class: 'daily-section' },
        h('div', { class: 'daily-section-head' }, h('b', null, `- ${sec.label}`), h('span', { class: 'muted small' }, sec.hint), h('span', { class: 'spacer' }), sec.count),
        sec.list,
        h('button', { class: 'link-btn small daily-add', onClick: () => {
          const r = row('', { checked: true });
          sec.list.append(r);
          r.querySelector('.daily-line').focus();
          refresh();
        } }, '+ Add line'),
      ),
    ),
  );

  async function load() {
    copyBtn.disabled = teamsBtn.disabled = regen.disabled = true;
    body.classList.add('loading');
    info.textContent = 'Reading your tasks from Jira…';
    try {
      const r = await api(`/api/daily-report${user ? `?user=${encodeURIComponent(user)}` : ''}`);
      site = r.site || '';
      headingIn.value = r.heading || '';
      sections[0].list.replaceChildren(...r.handedOver.map((t) => row(t.line, { key: t.key })));
      sections[1].list.replaceChildren(...r.pending.map((t) => row(t.line, { key: t.key })));
      copyBtn.disabled = teamsBtn.disabled = false;
      refresh();
    } catch (e) {
      info.textContent = `Could not build the report: ${e.message}`;
    } finally {
      body.classList.remove('loading');
      regen.disabled = false;
    }
  }

  const modal = h(
    'div',
    { class: 'daily-modal', onClick: (e) => e.target === modal && close() },
    h(
      'div',
      { class: 'daily-content', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Daily report' },
      h('div', { class: 'daily-head' }, h('h2', null, icon('doc'), 'Daily report', h('span', { class: 'muted daily-who' }, `· ${whoName}`)), h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onClick: close }, icon('x'))),
      body,
      info,
      h('div', { class: 'daily-actions' }, regen, h('span', { class: 'spacer' }), copyBtn, teamsBtn),
    ),
  );
  document.addEventListener('keydown', onKey, true);
  document.body.append(modal);
  await load();
}
window.openDailyReport = openDailyReport;

// Whose report: the person the header's user filter shows ('' = me). All / Unassigned have none.
const dailyWho = () => (typeof state !== 'undefined' ? state.user || '' : '');
const dailyForOne = () => !['__all__', '__unassigned__'].includes(dailyWho());
const dailyWhoName = () => (dailyWho() ? (typeof viewedUserName === 'function' ? viewedUserName() : 'selected user') : 'you');

// Header button (next to the bell): the daily report of the user the filter shows. The reminder (on/off, time,
// days) is in Settings → Daily report.
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

// Settings → Daily report: a button that sends the reminder now, the way it will come at the set time (desktop app:
// its own notification; browser: an OS notification that opens the report).
function dailySettingsExtra() {
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
window.dailySettingsExtra = dailySettingsExtra;

function setupDailyReport() {
  setupDailyButton();
  // From the reminder notification: always my own report, whoever the filter shows.
  window.electron?.daily?.onOpen(() => openDailyReport({ mine: true }));
  if (location.hash === '#daily-report') {
    history.replaceState(null, '', location.pathname + location.search);
    openDailyReport({ mine: true });
  }
}
