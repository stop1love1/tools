'use strict';

// DOM helpers, icons, local storage and the API client. Loaded first; every other script uses these.

// ---------------------------------------------------------------------------
// Tiny DOM helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const ICONS = {
  chev: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  chevUp: '<path d="m6 15 6-6 6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chart: '<path d="M4 20h16M7 20v-7M12 20V6M17 20v-10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  clip: '<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.3l7.9-7.9"/>',
  mr: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4m0 0 2.5-2.5M11 6l2.5 2.5"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  ai: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  flame: '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6.5-4-9.5-1.5 2-2 3.5-2 5.5-1.5-1-2.5-2.5-2.5-4.5C7.5 9 5 11.5 5 15a7 7 0 0 0 7 7z"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  tree: '<path d="M6 3v12a3 3 0 0 0 3 3h6M6 9h9"/><circle cx="18" cy="9" r="2"/><circle cx="18" cy="18" r="2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.7-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.4L20 16m0 4v-4h-4"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M16 7l3 3M14 9l2 2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  'circle-half': '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
  check: '<path d="M5 12.5 10 17 19 7"/>',
  branch: '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M6 7.5v9M18 9.5a6 6 0 0 1-6 6H8.5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  rebase: '<circle cx="6" cy="18" r="2.5"/><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7M18 11.5c0 3-3 4-6 4H8.5"/><path d="m14 3 3 3-3 3"/>',
  unlink: '<path d="M10 14a4 4 0 0 0 5.7 0l1.3-1.3M14 10a4 4 0 0 0-5.7 0L7 11.3"/><path d="M4 4l16 16"/>',
  sortAsc: '<path d="M4 7h10M4 12h7M4 17h4"/><path d="M16 17V7m0 0 3 3m-3-3-3 3"/>',
  sortDesc: '<path d="M4 7h4M4 12h7M4 17h10"/><path d="M16 7v10m0 0 3-3m-3 3-3-3"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem('jd:' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('jd:' + k, JSON.stringify(v));
    } catch {
      // Storage unavailable: preference just isn't remembered.
    }
  },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Dashboard': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  // The page is read fresh from disk but routes load at startup: a missing route means the server needs a restart.
  if (res.status === 404 && data.error === 'Not found') data.error = `${path.split('?')[0]} not found — the dashboard server is older than this page: restart it (npm start).`;
  // Signed out mid-session (even with the dashboard's own grant): bring back the sign-in item of the ⋯ menu.
  if (res.status === 401 && data.login) window.showLogin?.(true);
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, login: !!data.login, fields: data.fields });
  return data;
}

// ---------------------------------------------------------------------------
// Settings shared by the server (Settings page, lib/config.js). Filled before the first render.

const CFG = {
  jira: { defaultJql: '', presets: [], autoRefreshMinutes: 5 },
  git: { repos: [], projectKey: 'VLEARN', uat: 'uat', develop: 'develop', main: 'main', branchTypes: [], backupPruneDays: 14, mrChecklist: [] },
};

function applyClientConfig(c) {
  CFG.agent = c.agent || { model: '', mcp: true };
  Object.assign(CFG.jira, c.jira);
  Object.assign(CFG.git, c.git);
}

async function loadClientConfig() {
  try {
    applyClientConfig(await api('/api/client-config'));
  } catch (e) {
    console.warn('Could not load settings, using defaults:', e.message);
  }
}

const gitRepos = () => CFG.git.repos.map((r) => r.id);
const repoLabel = (id) => CFG.git.repos.find((r) => r.id === id)?.label || id;
const isMainBranch = (b) => [CFG.git.uat, CFG.git.develop, CFG.git.main].includes(b);
// "<KEY>-123" patterns for the configured Jira project key.
const ticketRe = (flags = '') => new RegExp(`${CFG.git.projectKey}-\\d+`, flags);
const stripTicket = (subject) => subject.replace(new RegExp(`^${CFG.git.projectKey}-\\d+: `), '');
