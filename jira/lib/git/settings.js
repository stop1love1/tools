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
    // <type>/<KEY>-<id>[-<id>…]-<description>-<uat|develop>
    taskRe: new RegExp(`^(${types})/${k}-(\\d+(?:-\\d+)*)-(.+)-(${escapeRe(uat)}|${escapeRe(develop)})$`),
    epicRe: /^epic\/[A-Z][A-Z0-9_]+-\d+$/,
    subjectRe: new RegExp(`^(${k}-(\\d+)):`), // "<KEY>-123: …" → [, ticket, id]
    ticketRe: new RegExp(`${k}-\\d+`),
    grep: (id) => `^${key}-${id}:`,
    ticket: (id) => `${key}-${id}`,
    // The -develop twin of a -uat task branch.
    toDevelop: (b) => b.replace(new RegExp(`-${escapeRe(uat)}$`), `-${develop}`),
  };
}

module.exports = { settings };
