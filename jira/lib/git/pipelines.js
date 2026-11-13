'use strict';

// CI pipelines (GitLab API through glab's stored login; needs the VPN).
// The team's CI runs on merge request events (merged-results / merge-train refs) and on pushes to develop / uat /
// release (deploys) — never on a plain task or epic branch. So a branch's pipeline is the latest pipeline of its MR,
// and a target branch's (develop / uat) is its latest push pipeline.

const { settings } = require('./settings');
const { webUrl } = require('./exec');
const { glabApi } = require('./mrs');
const { httpError } = require('../util');

const cache = new Map(); // `${repo}:mr:${iid}` | `${repo}:ref:${ref}` → { at, value }
const LIVE = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled']);
const ttl = (v) => (v && LIVE.has(v.status) ? 8_000 : 45_000);

const pick = (p) => p && { id: p.id, status: p.status, url: p.web_url, source: p.source, ref: p.ref, sha: p.sha?.slice(0, 9), updated: p.updated_at };

async function pipelines(repo, { mrs = [], refs = [] }, fresh = false) {
  const s = settings();
  const iids = mrs.map(Number);
  if (iids.length + refs.length === 0 || iids.length > 10 || refs.length > 3) throw httpError(400, 'Pass 1–10 mr=<iid> and up to 3 ref=<branch>');
  if (!iids.every((n) => Number.isInteger(n) && n > 0)) throw httpError(400, 'mr must be MR numbers');
  const allowed = new Set([s.uat, s.develop]);
  if (!refs.every((r) => allowed.has(r))) throw httpError(400, `ref must be ${[...allowed].join(' or ')}`);
  const web = await webUrl(s.repos[repo]);
  if (!web) throw httpError(400, 'origin is not a GitLab repository');
  const u = new URL(web);
  const project = `projects/${encodeURIComponent(u.pathname.slice(1))}`;
  const api = (endpoint) => glabApi(s.glab, u.host, `${project}/${endpoint}`, { paginate: false });

  const cached = async (key, load) => {
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ttl(hit.value)) return hit.value;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  // A failed pipeline: which jobs failed (what to open first).
  const withFailed = async (p) => {
    if (p?.status !== 'failed') return p;
    const jobs = await api(`pipelines/${p.id}/jobs?scope[]=failed&per_page=10`).catch(() => []);
    return { ...p, failed: jobs.map((j) => ({ name: j.name, stage: j.stage, url: j.web_url })) };
  };

  let error = null;
  const guard = (fn) => fn().catch((e) => ((error = e.message), null));
  const [byMr, byRef] = await Promise.all([
    Promise.all(iids.map((iid) => guard(() => cached(`${repo}:mr:${iid}`, async () => withFailed(pick((await api(`merge_requests/${iid}/pipelines?per_page=1`))[0])))).then((p) => [iid, p]))),
    Promise.all(refs.map((ref) => guard(() => cached(`${repo}:ref:${ref}`, async () => withFailed(pick((await api(`pipelines?ref=${encodeURIComponent(ref)}&source=push&per_page=1`))[0])))).then((p) => [ref, p]))),
  ]);
  return { repo, mrs: Object.fromEntries(byMr), refs: Object.fromEntries(byRef), error };
}

module.exports = { pipelines };
