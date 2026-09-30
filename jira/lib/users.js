'use strict';

// People to switch the view to: assignees active in the projects I work in.

const { callTool, searchAll } = require('./mcp');

let cache = { at: 0, data: null };

async function listUsers() {
  if (cache.data && Date.now() - cache.at < 10 * 60_000) return cache.data;
  const me = await callTool('atlassianUserInfo', {});
  const mine = await searchAll('assignee = currentUser() AND updated >= -90d ORDER BY updated DESC', ['project']);
  const projects = [...new Set(mine.map((i) => i.fields.project?.key).filter(Boolean))];
  const counts = new Map();
  if (projects.length) {
    const jql = `project in (${projects.join(',')}) AND assignee is not EMPTY AND updated >= -60d ORDER BY updated DESC`;
    for (const i of await searchAll(jql, ['assignee'])) {
      const a = i.fields.assignee;
      if (!a?.accountId) continue;
      const entry = counts.get(a.accountId) || { accountId: a.accountId, name: a.displayName || a.accountId, count: 0 };
      entry.count++;
      counts.set(a.accountId, entry);
    }
  }
  const users = [...counts.values()]
    .filter((u) => u.accountId !== me.account_id)
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  cache = { at: Date.now(), data: { me: me.account_id, projects, users } };
  return cache.data;
}

module.exports = { listUsers };
