'use strict';

// Status menu and toasts.

// ---------------------------------------------------------------------------
// Status menu

async function openStatusMenu(anchor, issue) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' }, h('div', { class: 'menu-note' }, 'Loading transitions…'));
  document.body.append(menu);
  state.menu = menu;
  state.menuAt = { key: issue.key, anchor, index: statusButtons(issue.key).indexOf(anchor) };
  placeMenu(menu, anchor);
  try {
    const ts = (await getTransitions(issue.key)).filter((t) => t.to.name !== issue.status.name);
    if (state.menu !== menu) return;
    menu.replaceChildren(
      ...(ts.length
        ? ts.map((t) =>
            h(
              'button',
              {
                class: 'menu-item',
                role: 'menuitem',
                onClick: () => {
                  closeMenu();
                  // The menu can outlive a reload (see holdMenu), which replaces the issue objects: act on the current one.
                  transition(state.issues.find((i) => i.key === issue.key) || issue, t);
                },
              },
              h('span', { class: `dot tone-${tone(t.to)}` }),
              h('span', null, t.name),
              t.name.toLowerCase() !== t.to.name.toLowerCase() && h('span', { class: 'muted small' }, `→ ${t.to.name}`),
            ),
          )
        : [h('div', { class: 'menu-note' }, 'No available transitions.')]),
    );
    placeMenu(menu, anchor);
    menu.querySelector('button')?.focus();
  } catch (e) {
    if (state.menu === menu) menu.replaceChildren(h('div', { class: 'menu-note err' }, e.message));
  }
}

function placeMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const below = r.bottom + 4 + mh <= innerHeight;
  menu.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - 4 - mh)) + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + 'px';
}

function closeMenu() {
  state.menu?.remove();
  state.menu = null;
  state.menuAt = null;
}

const statusButtons = (key) => [...document.querySelectorAll(`button.status[data-key="${CSS.escape(key)}"]`)];

// render() rebuilds every button, including the one the open menu hangs from. A status change re-renders the page
// several times, so a menu opened meanwhile on another task used to be closed under the user's click. Call this
// before the rebuild: it notes which button the menu hangs from and returns a function that, once the rebuild is
// done, moves the menu to the button that replaced it (or closes it when that row is gone, e.g. filtered out).
function holdMenu() {
  const at = state.menuAt;
  if (!state.menu || !at) return () => {};
  // After an earlier rebuild in the same tick the anchor is detached: keep the index noted before it.
  if (at.anchor.isConnected) at.index = statusButtons(at.key).indexOf(at.anchor);
  return () => {
    if (!state.menu || state.menuAt !== at) return; // closed or replaced meanwhile
    const next = statusButtons(at.key)[at.index];
    if (!next) return closeMenu();
    at.anchor = next;
    placeMenu(state.menu, next);
  };
}

// ---------------------------------------------------------------------------
// Toasts

function toast(message, kind = 'ok', link) {
  const el = h(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'spacer' }, message),
    link &&
      (link.onClick
        ? h(
            'button',
            {
              class: 'link-btn',
              onClick: () => {
                try {
                  link.onClick();
                } finally {
                  el.remove();
                }
              },
            },
            link.label,
          )
        : h('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label)),
  );
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 3500);
}
