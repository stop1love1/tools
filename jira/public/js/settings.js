'use strict';

// Settings page (gear button): edits config.json through /api/config. The form is built from the schema the
// server sends, so a new setting only needs an entry in lib/config.js.

const settingsState = { data: null, el: null, error: null, saving: false, errors: {} };

async function loadSettings() {
  try {
    settingsState.data = await api('/api/config');
    settingsState.error = null;
  } catch (e) {
    settingsState.error = e.message;
  }
  settingsState.el = null;
  if (state.view === 'settings') render();
}

// Kept across render() calls so edits survive a background reload of the task list.
function renderSettingsView() {
  if (!settingsState.data && !settingsState.error) {
    loadSettings();
    return h('div', { class: 'muted' }, 'Loading settings…');
  }
  if (settingsState.error) return h('div', { class: 'error-box' }, settingsState.error, ' ', h('button', { class: 'btn sm', onClick: loadSettings }, 'Retry'));
  settingsState.el ||= buildSettings(settingsState.data);
  return settingsState.el;
}

function buildSettings(data) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const inputs = new Map(); // key → { read(): value, set(value), row }
  const saveBtn = h('button', { class: 'btn primary', onClick: () => save() }, 'Save');
  const status = h('span', { class: 'muted small' });

  const refresh = () => {
    const changed = [...inputs].filter(([k, f]) => !same(f.read(), data.values[k])).length;
    status.textContent = changed ? `${changed} unsaved change${changed > 1 ? 's' : ''}` : 'All changes saved';
    saveBtn.disabled = !changed || settingsState.saving;
    for (const [k, f] of inputs) {
      f.row.classList.toggle('changed', !same(f.read(), data.values[k]));
      f.reset.hidden = same(f.read(), data.defaults[k]);
    }
  };

  async function save() {
    const values = Object.fromEntries([...inputs].filter(([k, f]) => !same(f.read(), data.values[k])).map(([k, f]) => [k, f.read()]));
    if (!Object.keys(values).length) return;
    settingsState.saving = true;
    saveBtn.disabled = true;
    try {
      const res = await api('/api/config', { method: 'PUT', body: JSON.stringify({ values }) });
      settingsState.data = res;
      settingsState.errors = {};
      afterSave(res, values);
      settingsState.el = null;
      toast(res.pendingRestart.length ? 'Settings saved — restart the server for the marked fields' : 'Settings saved');
    } catch (e) {
      settingsState.errors = e.fields || {};
      toast(e.message, 'error');
      for (const [k, f] of inputs) f.err.textContent = settingsState.errors[k] || '';
    } finally {
      settingsState.saving = false;
      if (state.view === 'settings') render();
    }
  }

  const sections = data.schema.map((sec) =>
    h(
      'section',
      { class: 'set-card' },
      h('h3', null, sec.section),
      sec.fields.map((f) => {
        const field = fieldInput(f, data.values[f.key], refresh);
        const reset = h('button', { class: 'link-btn small', title: `Default: ${preview(data.defaults[f.key])}`, onClick: () => (field.set(data.defaults[f.key]), refresh()) }, 'Reset to default');
        const err = h('div', { class: 'set-err' }, settingsState.errors[f.key] || '');
        const row = h(
          'div',
          { class: 'set-row' },
          h(
            'div',
            { class: 'set-label' },
            h('label', null, f.label),
            f.restart && h('span', { class: `gchip ${data.pendingRestart.includes(f.key) ? 'warn' : ''}`, title: 'Read when the server starts' }, data.pendingRestart.includes(f.key) ? 'restart pending' : 'needs restart'),
            f.help && h('div', { class: 'muted small' }, f.help),
          ),
          h('div', { class: 'set-input' }, field.el, err, reset),
        );
        inputs.set(f.key, { ...field, row, reset, err });
        return row;
      }),
    ),
  );

  const el = h(
    'div',
    { class: 'settings' },
    h(
      'div',
      { class: 'set-head' },
      h('h2', { class: 'section-title' }, icon('gear'), 'Settings'),
      h('span', { class: 'muted small set-file', title: data.file }, 'Saved to ', data.file),
      h('span', { class: 'spacer' }),
      status,
      saveBtn,
    ),
    data.pendingRestart.length > 0 && h('div', { class: 'gconflict ghint' }, 'Restart the server (npm start) to apply: ', data.pendingRestart.map((k) => h('code', { class: 'gcode' }, k))),
    sections,
    mcpConnectCard(data.values['mcp.enabled']),
  );
  refresh();
  return el;
}

const preview = (v) => (Array.isArray(v) ? `${v.length} item(s)` : String(v));

// One input per schema type; each returns { el, read(), set(value) }.
function fieldInput(f, value, onChange) {
  if (f.type === 'lines') {
    const ta = h('textarea', { class: `gin${f.mono ? ' mono' : ''}`, rows: String(Math.min(12, Math.max(3, value.length + 1))), spellcheck: 'false', onInput: onChange });
    const set = (v) => (ta.value = v.join('\n'));
    set(value);
    return { el: ta, set, read: () => ta.value.split('\n').map((l) => l.trim()).filter(Boolean) };
  }
  if (f.type === 'bool') {
    const box = h('input', { type: 'checkbox', onChange: onChange });
    const set = (v) => (box.checked = !!v);
    set(value);
    return { el: h('label', { class: 'set-switch' }, box, h('span', null, 'On')), set, read: () => box.checked };
  }
  if (f.type === 'presets') return listInput(value, onChange, [['label', 'Label', 'set-col-s'], ['jql', 'JQL', 'mono']], { label: '', jql: '' }, 'Add filter');
  if (f.type === 'repos') return listInput(value, onChange, [['id', 'id', 'mono set-col-xs'], ['label', 'Label', 'set-col-s'], ['dir', 'Folder', 'mono']], { id: '', label: '', dir: '' }, 'Add repo');
  const input = h('input', {
    class: `gin${f.mono || f.type === 'path' || f.type === 'url' ? ' mono' : ''}`,
    type: f.type === 'number' ? 'number' : 'text',
    min: f.min,
    max: f.max,
    spellcheck: 'false',
    autocomplete: 'off',
    onInput: onChange,
  });
  const set = (v) => (input.value = v);
  set(value);
  return { el: input, set, read: () => (f.type === 'number' ? (input.value === '' ? NaN : Number(input.value)) : input.value.trim()) };
}

// Editable table of objects (saved filters, repos): one row per item, a text input per column.
function listInput(value, onChange, cols, blank, addLabel) {
  const body = h('div', { class: 'set-list' });
  const rowOf = (item) => {
    const cells = cols.map(([k, ph, cls]) => h('input', { class: `gin ${cls || ''}`, placeholder: ph, value: item[k] ?? '', spellcheck: 'false', autocomplete: 'off', 'data-k': k, onInput: onChange }));
    const del = h('button', { class: 'icon-btn sm', title: 'Remove', onClick: () => (row.remove(), onChange()) }, icon('trash'));
    const up = h('button', { class: 'icon-btn sm', title: 'Move up', onClick: () => (row.previousElementSibling?.before(row), onChange()) }, icon('chevUp'));
    const row = h('div', { class: 'set-list-row' }, cells, up, del);
    return row;
  };
  const set = (v) => body.replaceChildren(...v.map(rowOf));
  set(value);
  const add = h('button', { class: 'btn sm', onClick: () => (body.append(rowOf(blank)), body.lastChild.querySelector('input').focus(), onChange()) }, addLabel);
  const read = () => [...body.children].map((row) => Object.fromEntries([...row.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()])));
  return { el: h('div', null, body, add), set, read };
}

// Apply what the browser uses right away; the server already uses the new values.
function afterSave(res, changed) {
  applyClientConfig(res.client);
  renderPresets();
  scheduleRefresh();
  const keys = Object.keys(changed);
  if (keys.some((k) => k.startsWith('git.'))) {
    gitState.overview = null;
    gitState.branches = {};
    gitState.mrData = {};
    refreshGit();
  }
  if (keys.some((k) => k.startsWith('jira.'))) {
    cache.details.clear();
    load({ silent: true });
  }
}

// How to plug Claude Code / Cursor into the dashboard's MCP endpoint.
function mcpConnectCard(enabled) {
  const url = `${location.origin}/mcp`;
  const snippet = (title, text) =>
    h(
      'div',
      { class: 'set-snippet' },
      h('div', { class: 'set-snippet-head' }, h('b', null, title), h('button', { class: 'icon-btn sm', title: 'Copy', onClick: () => copyText(text, 'Copied') }, icon('copy'))),
      h('pre', { class: 'mono' }, text),
    );
  return h(
    'section',
    { class: 'set-card' },
    h('h3', null, 'Connect an AI tool'),
    h(
      'p',
      { class: 'muted small' },
      enabled ? ['The dashboard serves MCP at ', h('code', { class: 'gcode' }, url), ' while it runs. Only tools on this machine can reach it.'] : 'Turn on "Serve MCP at /mcp" above first.',
    ),
    snippet('Claude Code (terminal)', `claude mcp add --transport http --scope user jira-dashboard ${url}`),
    snippet('Cursor — ~/.cursor/mcp.json', JSON.stringify({ mcpServers: { 'jira-dashboard': { url } } }, null, 2)),
    snippet('Claude Code — .mcp.json in a project', JSON.stringify({ mcpServers: { 'jira-dashboard': { type: 'http', url } } }, null, 2)),
  );
}
