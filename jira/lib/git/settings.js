'use strict';

// Git flow settings derived from the dashboard config: repo paths, branch names and the patterns built from them.
// Read per request, so a change on the Settings page applies to the next call.

const path = require('node:path');
const config = require('../config');
const { escapeRe } = require('../util');

function settings() {
  const g = config.get().git;
  const key = g.projectKey;
  const k = escapeRe(key);
  const types = g.branchTypes.map(escapeRe).join('|');
  const uat = g.uatBranch;
  const develop = g.developBranch;
  // <type>/<KEY>-123[-124…]-<description>-<uat|develop>
  const taskRe = new RegExp(`^(${types})/${k}-(\\d+(?:-\\d+)*)-(.+)-(${escapeRe(uat)}|${escapeRe(develop)})$`);
  // Older naming without the suffix (feature/<KEY>-4546-4547-<description>): still the tickets' task branch, on the uat track.
  const legacyRe = new RegExp(`^(${types})/${k}-(\\d+(?:-\\d+)*)-(.+)$`);
  return {
    root: g.root,
    scratchRoot: g.scratchRoot,
    repos: Object.fromEntries(g.repos.map((r) => [r.id, path.join(g.root, r.dir)])),
    key,
    uat,
    develop,
    main: g.mainBranch,
    // Branches the dashboard never pushes to or deletes.
    isProtected: (b) => [uat, develop, g.mainBranch].includes(b) || b.startsWith('release/'),
    since: `--since=${g.commitLookbackDays}.days`, // how far back a ticket's commits are looked up
    mrDays: g.mrLookbackDays, // MRs updated within this window are matched to branches
    glab: g.glabBin,
    // Same pattern as the frontend commit-msg hook.
    branchRe: new RegExp(`^(epic|${types})/${k}-[0-9]+(-[a-z0-9._-]+)?$`),
    taskRe,
    // A task branch's parts: { ids, track: 'uat' | 'develop', legacy } (legacy: no suffix, counts as uat), or null.
    taskMatch: (b) => {
      const m = b.match(taskRe);
      if (m) return { ids: m[2].split('-'), track: m[4] === uat ? 'uat' : 'develop', legacy: false };
      const l = b.match(legacyRe);
      return l ? { ids: l[2].split('-'), track: 'uat', legacy: true } : null;
    },
    epicRe: /^epic\/[A-Z][A-Z0-9_]+-\d+$/,
    subjectRe: new RegExp(`^(${k}-(\\d+)):`), // "<KEY>-123: …" → [, ticket, id]
    ticketRe: new RegExp(`${k}-\\d+`),
    grep: (id) => `^${key}-${id}:`,
    ticket: (id) => `${key}-${id}`,
    // The -develop twin of a -uat (or suffix-less) task branch.
    toDevelop: (b) => (b.endsWith(`-${uat}`) ? b.slice(0, -uat.length) : `${b}-`) + develop,
  };
}

module.exports = { settings };
