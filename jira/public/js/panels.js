'use strict';

// Notifications and recently-viewed panels.

// ---------------------------------------------------------------------------
// Notifications (other people's changes/comments on my issues, last 7 days)

async function loadNotifications({ fresh = false } = {}) {
  try {
    const d = await api('/api/notifications' + (fresh ? '?fresh=1' : ''));
    state.notif.events = d.events;
    state.notif.days = d.days;
    state.notif.error = null;
  } catch (e) {
    state.notif.error = e.message;
  }
  state.notif.loaded = true;
  renderBell();
  if (state.notif.open) renderNotifPanel();
}

function renderBell() {
  const unread = state.notif.events.filter((e) => Date.parse(e.at) > state.notif.seen).length;
  const badge = $('#bell-badge');
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  const bell = $('#bell');
  if (bell) bell.title = unread ? `${unread} new notifications` : 'Notifications';
}

function toggleNotif(force) {
  const n = state.notif;
  n.open = force ?? !n.open;
  $('#notif').hidden = !n.open;
  $('#bell').setAttribute('aria-expanded', String(n.open));
  if (!n.open) return;
  // Opening marks everything read; keep the previous mark to highlight what was new.
  n.seenBefore = n.seen;
  n.seen = Date.now();
  LS.set('notifSeen', n.seen);
  renderBell();
  renderNotifPanel();
  if (!n.loaded) loadNotifications();
}

function toggleRecent(force) {
  const recent = $('#recent');
  const isOpen = force ?? recent.hidden;
  recent.hidden = !isOpen;
  $('#recent-btn').setAttribute('aria-expanded', String(isOpen));
  if (!isOpen) return;
  renderRecentPanel();
}

function renderRecentPanel() {
  const recent = $('#recent');
  const viewed = state.recentlyViewed
    .map(key => state.issues.find(i => i.key === key) || { key, summary: '(not in current filter)', url: null })
    .slice(0, 10);
  
  const item = (i) =>
    h(
      'button',
      {
        class: 'notif-item',
        onClick: () => {
          toggleRecent(false);
          openIssueChip(i.key);
        },
      },
      i.type && h('span', { class: 'avatar' }, typeBadge(i.type.name)),
      h(
        'span',
        { class: 'notif-body' },
        h('span', { class: 'notif-issue' }, h('span', { class: 'key' }, i.key), h('span', { class: 'notif-sum' }, i.summary)),
        i.status && h('span', { class: 'muted small' }, i.status.name),
      ),
    );
  
  recent.replaceChildren(
    h(
      'div',
      { class: 'notif-head' },
      h('b', null, 'Recently Viewed'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn sm', title: 'Clear', onClick: () => {
        state.recentlyViewed = [];
        LS.set('recentlyViewed', []);
        renderRecentPanel();
      }}, icon('trash')),
      h('button', { class: 'icon-btn sm', title: 'Close', onClick: () => toggleRecent(false) }, icon('x')),
    ),
    h(
      'div',
      { class: 'notif-list' },
      viewed.length
        ? viewed.map(item)
        : h('div', { class: 'notif-empty' }, 'No recently viewed issues.'),
    ),
  );
}

function renderNotifPanel() {
  const n = state.notif;
  // "First Last - CODE123" / "First Last (DEPT-…)" → drop the employee-code suffix first.
  const initials = (name) =>
    name
      .split(/\s+[-(]/)[0]
      .split(/\s+/)
      .filter(Boolean)
      .slice(-2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?';
  const verb = (e) => (e.kind === 'comment' ? (e.mention ? 'mentioned you in a comment' : 'commented') : e.text);
  const item = (e) =>
    h(
      'button',
      {
        class: `notif-item${Date.parse(e.at) > n.seenBefore ? ' unread' : ''}${e.mention ? ' mention' : ''}`,
        onClick: () => {
          toggleNotif(false);
          openIssueChip(e.issue.key);
        },
      },
      h('span', { class: `avatar k-${e.kind}` }, initials(e.author)),
      h(
        'span',
        { class: 'notif-body' },
        h('span', { class: 'notif-line' }, h('b', null, e.author || 'Someone'), ' ', verb(e)),
        e.kind === 'comment' && e.text && h('span', { class: 'notif-quote' }, e.text),
        h('span', { class: 'notif-issue' }, typeBadge(e.issue.type), h('span', { class: 'key' }, e.issue.key), h('span', { class: 'notif-sum' }, e.issue.summary)),
        h('span', { class: 'muted small', title: fmtDate(e.at) }, rel(e.at)),
      ),
    );
  $('#notif').replaceChildren(
    h(
      'div',
      { class: 'notif-head' },
      h('b', null, 'Notifications'),
      h('span', { class: 'muted small' }, `Last ${n.days} days · tasks you work on, created or watch`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn sm', title: 'Reload notifications', onClick: () => loadNotifications({ fresh: true }) }, icon('refresh')),
      h('button', { class: 'icon-btn sm', title: 'Close', onClick: () => toggleNotif(false) }, icon('x')),
    ),
    h(
      'div',
      { class: 'notif-list' },
      !n.loaded
        ? h('div', { class: 'notif-empty' }, 'Loading…')
        : n.error
          ? h('div', { class: 'notif-empty err' }, n.error)
          : n.events.length
            ? n.events.map(item)
            : h('div', { class: 'notif-empty' }, 'No new activity from others.'),
    ),
  );
}
