'use strict';

// Merge requests (GitLab API through glab's stored login; needs the VPN)

const { execFile } = require('node:child_process');
const { settings } = require('./settings');
const { webUrl } = require('./exec');
const { httpError } = require('../util');

const cache = new Map(); // repo → { at, promise }

function glabApi(bin, host, endpoint) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['api', '--hostname', host, '--paginate', endpoint], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr || err.message);
        const why = err.code === 'ENOENT' ? `${bin} not found` : err.killed || /timeout|dial tcp/i.test(text) ? 'GitLab not reachable (VPN?)' : text.trim().split('\n').pop();
        return reject(httpError(502, why));
      }
      // --paginate prints one JSON array per page.
      const pages = String(stdout).trim().replace(/\]\s*\[/g, ',');
      resolve(JSON.parse(pages || '[]'));
    });
  });
}

async function projectMrs(repo) {
  const s = settings();
  const web = await webUrl(s.repos[repo]);
  if (!web) throw httpError(400, 'origin is not a GitLab repository');
  const u = new URL(web);
  const since = new Date(Date.now() - s.mrDays * 86_400_000).toISOString();
  const list = await glabApi(s.glab, u.host, `projects/${encodeURIComponent(u.pathname.slice(1))}/merge_requests?state=all&per_page=100&updated_after=${since}`);
  const byBranch = {};
  for (const m of list) {
    (byBranch[m.source_branch] ||= []).push({
      iid: m.iid,
      state: m.state, // opened | merged | closed | locked
      draft: !!(m.draft || m.work_in_progress),
      title: m.title,
      target: m.target_branch,
      url: m.web_url,
      author: m.author?.name || '',
      updated: m.updated_at,
      merged: m.merged_at || null,
      conflicts: !!m.has_conflicts,
      comments: m.user_notes_count || 0,
      // false = some threads that block merging are still unresolved
      resolved: m.blocking_discussions_resolved !== false,
      status: m.detailed_merge_status || m.merge_status || null,
    });
  }
  for (const mrs of Object.values(byBranch)) mrs.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  return { repo, byBranch, at: Date.now() };
}

// Cached 60s (30s after a failure) so the drawer and the Git view share one call per repo.
function mrs(repo, fresh) {
  const hit = cache.get(repo);
  if (!fresh && hit && Date.now() - hit.at < (hit.failed ? 30_000 : 60_000)) return hit.promise;
  const entry = { at: Date.now(), failed: false };
  entry.promise = projectMrs(repo).catch((e) => {
    entry.failed = true;
    return { repo, byBranch: null, error: e.message, at: Date.now() };
  });
  cache.set(repo, entry);
  return entry.promise;
}

const clearMrs = () => cache.clear();

module.exports = { mrs, clearMrs };
