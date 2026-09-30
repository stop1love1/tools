'use strict';

// Status menu and toasts.

// ---------------------------------------------------------------------------
// Status menu

async function openStatusMenu(anchor, issue) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' }, h('div', { class: 'menu-note' }, 'Loading transitions…'));
  document.body.append(menu);
  state.menu = menu;
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
                  transition(issue, t);
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
}

// ---------------------------------------------------------------------------
// Toasts

function toast(message, kind = 'ok', link) {
  const el = h(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'spacer' }, message),
    link && h('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label),
  );
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 3500);
}
