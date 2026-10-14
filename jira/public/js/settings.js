'use strict';

const settingsState = { data: null, el: null, error: null, saving: false, errors: {}, dirty: false };

addEventListener('beforeunload', (e) => {
  if (!settingsState.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

let settingsIds = 0;

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
  const inputs = new Map();
  const saveBtn = h('button', { class: 'btn primary', onClick: () => save() }, 'Save');
  const status = h('span', { class: 'muted small', role: 'status' });

  const refresh = (e) => {
    const t = e?.target;
    if (t instanceof Node) {
      for (const [k, f] of inputs) {
        if (f.row.contains(t) && f.err.textContent) {
          f.err.textContent = '';
          delete settingsState.errors[k];
        }
      }
    }
    const changed = [...inputs].filter(([k, f]) => !same(f.read(), data.values[k])).length;
    settingsState.dirty = changed > 0;
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
      settingsState.dirty = false;
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
        const reset = h('button', { class: 'link-btn small', title: `Default: ${preview(data.defaults[f.key])}`, 'aria-label': `Reset ${f.label} to default`, onClick: () => (field.set(data.defaults[f.key]), refresh()) }, 'Reset to default');
        const err = h('div', { class: 'set-err', id: `set-err-${++settingsIds}`, role: 'alert' }, settingsState.errors[f.key] || '');
        const labelId = `set-lbl-${settingsIds}`;
        const label = h('label', { id: labelId }, f.label);
        const control = field.el.matches('input, textarea') ? field.el : field.el.querySelector('input[type=checkbox]');
        if (control) {
          control.id = `set-in-${settingsIds}`;
          label.setAttribute('for', control.id);
          control.setAttribute('aria-describedby', err.id);
          if (control.type === 'checkbox') control.setAttribute('aria-labelledby', labelId);
        } else {
          field.el.setAttribute('role', 'group');
          field.el.setAttribute('aria-labelledby', labelId);
        }
        const row = h(
          'div',
          { class: 'set-row' },
          h(
            'div',
            { class: 'set-label' },
            label,
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
    ),
    data.pendingRestart.length > 0 && h('div', { class: 'gconflict ghint' }, 'Restart the server (npm start) to apply: ', data.pendingRestart.map((k) => h('code', { class: 'gcode' }, k))),
    sections,
    mcpConnectCard(data),
    h('div', { class: 'set-bar' }, status, saveBtn),
  );
  refresh();
  return el;
}

function preview(v) {
  const text = Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? x.label || x.id : x)).join(', ') : String(v);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function fieldInput(f, value, onChange) {
  if (f.type === 'lines') {
    const ta = h('textarea', { class: `gin${f.mono ? ' mono' : ''}`, rows: String(Math.min(12, Math.max(3, value.length + 1))), spellcheck: 'false', onInput: onChange });
    const set = (v) => (ta.value = v.join('\n'));
    set(value);
    return { el: ta, set, read: () => ta.value.split('\n').map((l) => l.trim()).filter(Boolean) };
  }
  if (f.type === 'bool') {
    const text = h('span', null);
    const box = h('input', { type: 'checkbox', role: 'switch' });
    const sync = () => (text.textContent = box.checked ? 'On' : 'Off');
    box.addEventListener('change', (e) => (sync(), onChange(e)));
    const set = (v) => ((box.checked = !!v), sync());
    set(value);
    return { el: h('label', { class: 'set-switch' }, box, text), set, read: () => box.checked };
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

function listInput(value, onChange, cols, blank, addLabel) {
  const body = h('div', { class: 'set-list' });
  const relabel = () => {
    [...body.children].forEach((row, i) => {
      row.querySelectorAll('input').forEach((inp) => inp.setAttribute('aria-label', `${inp.placeholder}, row ${i + 1}`));
      row.querySelector('[data-act=up]').setAttribute('aria-label', `Move row ${i + 1} up`);
      row.querySelector('[data-act=del]').setAttribute('aria-label', `Remove row ${i + 1}`);
      row.querySelector('[data-act=up]').disabled = i === 0;
    });
  };
  const rowOf = (item) => {
    const cells = cols.map(([k, ph, cls]) => h('input', { class: `gin ${cls || ''}`, placeholder: ph, value: item[k] ?? '', spellcheck: 'false', autocomplete: 'off', 'data-k': k, onInput: onChange }));
    const del = h('button', { class: 'icon-btn sm', title: 'Remove', 'data-act': 'del', onClick: () => (row.remove(), relabel(), onChange()) }, icon('trash'));
    const up = h('button', { class: 'icon-btn sm', title: 'Move up', 'data-act': 'up', onClick: () => (row.previousElementSibling?.before(row), relabel(), onChange()) }, icon('chevUp'));
    const row = h('div', { class: 'set-list-row' }, cells, up, del);
    return row;
  };
  const set = (v) => (body.replaceChildren(...v.map(rowOf)), relabel());
  set(value);
  const add = h('button', { class: 'btn sm', onClick: () => (body.append(rowOf(blank)), relabel(), body.lastChild.querySelector('input').focus(), onChange()) }, addLabel);
  const read = () => [...body.children].map((row) => Object.fromEntries([...row.querySelectorAll('input')].map((i) => [i.dataset.k, i.value.trim()])));
  return { el: h('div', null, body, add), set, read };
}

function afterSave(res, changed) {
  applyClientConfig(res.client);
  renderPresets();
  scheduleRefresh();
  const keys = Object.keys(changed);
  if (keys.some((k) => k.startsWith('git.')) && typeof gitState !== 'undefined') {
    gitState.overview = null;
    gitState.branches = {};
    gitState.mrData = {};
    refreshGit();
  }
  if (keys.some((k) => k.startsWith('jira.'))) {
    cache.details.clear();
    if (typeof load === 'function') load({ silent: true });
  }
}

function mcpConnectCard(data) {
  const enabled = data.values['mcp.enabled'];
  const writes = data.values['mcp.allowWrites'];
  const url = `${location.origin}/mcp`;
  const tokenFile = data.mcpTokenFile || '.mcp-token';
  const authHeader = `Bearer <contents of ${tokenFile}>`;
  const entry = (type) => ({ ...(type ? { type } : {}), url, ...(writes ? { headers: { Authorization: authHeader } } : {}) });
  const snippet = (title, text) =>
    h(
      'div',
      { class: 'set-snippet' },
      h('div', { class: 'set-snippet-head' }, h('b', null, title), h('button', { class: 'icon-btn sm', title: 'Copy', 'aria-label': `Copy ${title}`, onClick: () => copyText(text, 'Copied') }, icon('copy'))),
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
    writes && h('p', { class: 'muted small' }, 'Write tools are on, so clients must send the token. Replace the placeholder with the contents of ', h('code', { class: 'gcode' }, tokenFile), '.'),
    snippet('Claude Code (terminal)', `claude mcp add --transport http --scope user jira-dashboard ${url}${writes ? ` --header "Authorization: Bearer $(cat ${tokenFile})"` : ''}`),
    snippet('Cursor — ~/.cursor/mcp.json', JSON.stringify({ mcpServers: { 'jira-dashboard': entry() } }, null, 2)),
    snippet('Claude Code — .mcp.json in a project', JSON.stringify({ mcpServers: { 'jira-dashboard': entry('http') } }, null, 2)),
  );
}
