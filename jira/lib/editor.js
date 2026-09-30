'use strict';

// Opening things in the editor (Cursor by default): a folder, or a URL for Claude Code's extension.

const { spawn } = require('node:child_process');
const config = require('./config');
const { httpError } = require('./util');

// ELECTRON_RUN_AS_NODE (set when launched from an editor extension) would turn the CLI into plain Node.
function editorEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// Passes a cursor:// URL to the running editor via its CLI (`cursor --open-url`), which forwards it
// to the open window and exits. Not xdg-open: the desktop may have no cursor:// handler registered.
function openUrl(url) {
  const bin = config.get().editor.bin;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--open-url', url], { env: editorEnv(), detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    // A CLI that starts a fresh editor instead of forwarding never exits; treat that as opened.
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, 15_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(httpError(500, `Could not run "${bin}" (${e.code || e.message}). Set the editor command in Settings.`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const last = stderr.trim().split('\n').filter((l) => !/^\[\d+:/.test(l)).pop() || '';
      reject(httpError(500, `${bin} --open-url failed (exit ${code}) ${last}`.trim()));
    });
  });
}

// Claude Code's editor extension opens a new tab with a prefilled prompt for <scheme>://anthropic.claude-code/open?prompt=…
const openClaudeCode = (prompt) => openUrl(`${config.get().editor.uriScheme}://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`);

function openFolder(dir) {
  const child = spawn(config.get().editor.bin, [dir], { env: editorEnv(), detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

module.exports = { openClaudeCode, openFolder };
