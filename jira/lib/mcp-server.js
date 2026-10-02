'use strict';

// MCP server at /mcp (streamable HTTP, JSON responses, no sessions) so AI tools on this machine — Claude Code,
// Cursor… — can use the dashboard: Jira issues with their Confluence docs, notifications, and the git flow.
// Write tools (Jira transitions, git steps, MR creation) are only listed when Settings → MCP → "Allow write tools" is on.
//
//   claude mcp add --transport http jira-dashboard http://localhost:4747/mcp
//   Cursor (~/.cursor/mcp.json): { "mcpServers": { "jira-dashboard": { "url": "http://localhost:4747/mcp" } } }

const config = require('./config');
const issues = require('./issues');
const notifications = require('./notifications');
const gitRead = require('./git/read');
const git = require('./git');
const { getJob } = require('./git/jobs');
const { settings: gitSettings } = require('./git/settings');
const { createMergeRequest, MR_KINDS } = require('./git/merge-requests');
const { callTool } = require('./mcp');
const prompt = require('./prompt');
const { httpError, send, readJson, htmlToText } = require('./util');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

// ---------------------------------------------------------------------------
// Helpers

const issueKey = (k) => {
  const key = String(k || '').trim().toUpperCase();
  if (!KEY_RE.test(key)) throw httpError(400, `Invalid issue key "${k}" (expected e.g. ${gitSettings().key}-123)`);
  return key;
};

// The list view of an issue: enough to pick one, without descriptions.
const issueRow = (i) => ({
  key: i.key,
  summary: i.summary,
  type: i.type.name,
  status: i.status?.name,
  statusCategory: i.status?.category,
  priority: i.priority,
  due: i.due,
  updated: i.updated,
  sprint: i.sprint?.name || null,
  storyPoints: i.storyPoints,
  parent: i.parent ? `${i.parent.key} ${i.parent.summary}` : null,
  epic: i.epic ? `${i.epic.key} ${i.epic.summary}` : null,
  labels: i.labels.length ? i.labels : undefined,
  docs: i.docs.length ? i.docs.map((d) => ({ title: d.title, url: d.url })) : undefined,
  url: i.url,
});

// Polls a git job until it ends or `waitSeconds` pass.
async function waitJob(id, waitSeconds = 120) {
  const until = Date.now() + Math.min(Math.max(waitSeconds, 0), 600) * 1000;
  let job = getJob(id);
  while (job && job.status === 'running' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    job = getJob(id);
  }
  if (!job) throw httpError(404, 'Job not found');
  return { id: job.id, title: job.title, status: job.status, error: job.error, result: job.result, log: job.log.join('\n').slice(-12_000) };
}

// ---------------------------------------------------------------------------
// Tools

const str = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'task_brief',
    description:
      'Everything needed to work on a Jira ticket, in one call: the ticket (description, comments, sub-tasks, Confluence pages, MRs), ' +
      'its git state in the chosen repos (epic / task / develop branches, checkout) and the numbered steps to follow for the chosen options. ' +
      'Call it first when asked to plan or implement a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        key: str('Issue key, e.g. VLEARN-123'),
        mode: { type: 'string', enum: ['implement', 'plan'] },
        repos: { type: 'array', items: { type: 'string' }, description: 'Repo ids to work in (default: the first repo)' },
        mrKinds: { type: 'array', items: { type: 'string', enum: Object.keys(MR_KINDS) }, description: 'MRs to open (default: task-epic)' },
        draft: { type: 'boolean' },
        moveStatus: { type: 'boolean', description: 'Move the Jira status along (default true)' },
      },
      required: ['key'],
    },
    run: (args) => prompt.brief(args),
  },
  {
    name: 'list_issues',
    description:
      'List Jira issues (default: my open work and what I finished in the last 14 days). Returns key, summary, status, type, priority, due date, sprint, story points, parent, epic and linked Confluence docs.',
    inputSchema: { type: 'object', properties: { jql: str('JQL; omit for the dashboard default filter'), limit: { type: 'number', description: 'Max issues to return (default 100)' } } },
    run: async ({ jql, limit = 100 }) => {
      const q = String(jql || '').trim() || config.get().jira.defaultJql;
      const list = await issues.listIssues(q);
      return { jql: q, total: list.length, issues: list.slice(0, Math.max(1, Math.min(Number(limit) || 100, 300))).map(issueRow) };
    },
  },
  {
    name: 'get_issue',
    description: 'One Jira issue in full: description, comments, sub-tasks, linked Confluence pages (own and inherited from the parent), MRs and other links.',
    inputSchema: { type: 'object', properties: { key: str('Issue key, e.g. VLEARN-123') }, required: ['key'] },
    run: async ({ key }) => {
      const d = await issues.issueDetail(issueKey(key));
      return {
        ...issueRow(d.issue),
        assignee: d.assignee,
        reporter: d.reporter,
        description: htmlToText(d.descriptionHtml),
        comments: d.comments.map((c) => ({ author: c.author, created: c.created, text: htmlToText(c.html) })),
        subtasks: d.children.map((c) => ({ key: c.key, summary: c.summary, type: c.type, status: c.status?.name, assignee: c.assignee })),
        confluence: [...d.issue.docs, ...d.confluence].map((c) => ({ title: c.title, url: c.url, pageId: c.pageId, from: c.from })),
        links: d.links.map((l) => ({ kind: l.kind, title: l.title, url: l.url })),
        attachments: d.issue.attachments.map((a) => ({ filename: a.filename, size: a.size, url: a.url })),
      };
    },
  },
  {
    name: 'get_confluence_page',
    description: 'The content of a Confluence page (as Markdown) by page id — e.g. the PRD / spec linked from an issue (get_issue lists the page ids).',
    inputSchema: { type: 'object', properties: { pageId: str('Numeric Confluence page id') }, required: ['pageId'] },
    run: async ({ pageId }) => {
      if (!/^\d+$/.test(String(pageId))) throw httpError(400, 'pageId must be numeric');
      const p = await callTool('getConfluencePage', { pageId: String(pageId), contentFormat: 'markdown' });
      return typeof p === 'string' ? p : { title: p.title, url: p._links?.webui ? `${config.get().jira.siteUrl.replace(/\/+$/, '')}/wiki${p._links.webui}` : undefined, body: p.body?.storage?.value ?? p.body ?? p };
    },
  },
  {
    name: 'list_transitions',
    description: 'The workflow transitions available for a Jira issue right now (id, name, target status).',
    inputSchema: { type: 'object', properties: { key: str('Issue key') }, required: ['key'] },
    run: async ({ key }) => ({ transitions: await issues.listTransitions(issueKey(key)) }),
  },
  {
    name: 'get_notifications',
    description: "Other people's recent changes and comments on issues I'm assigned to, reported or watch (newest first).",
    inputSchema: { type: 'object', properties: { fresh: { type: 'boolean', description: 'Skip the 60 s cache' } } },
    run: async ({ fresh }) => {
      if (fresh) notifications.invalidate();
      return notifications.listNotifications();
    },
  },
  {
    name: 'git_overview',
    description: 'The configured repos: checked-out branch, uncommitted files, ahead/behind, stashes, other worktrees and any rebase/cherry-pick in progress.',
    inputSchema: { type: 'object', properties: {} },
    run: () => gitRead.overview(),
  },
  {
    name: 'git_flow',
    description:
      "Where a ticket stands in the team git flow, per repo: its epic branch, task branch (-uat) — the primary one, plus all the ticket's branches with unmerged-commit counts under `branches` —, develop branch, the ticket's commits and whether each is in the epic / uat / develop, sync with origin, conflicts and rule warnings.",
    inputSchema: { type: 'object', properties: { key: str('Issue key'), epic: str('Epic key to use instead of the parent Epic on Jira') }, required: ['key'] },
    run: ({ key, epic }) => gitRead.flow(issueKey(key), epic ? issueKey(epic) : null),
  },
  {
    name: 'git_epic',
    description: "What an epic branch carries: its commits grouped by task merge, which tickets they belong to, and which are already on develop.",
    inputSchema: { type: 'object', properties: { key: str('Epic issue key') }, required: ['key'] },
    run: ({ key }) => gitRead.epicView(issueKey(key)),
  },
  {
    name: 'git_branches',
    description: 'Local branches of a repo with upstream state, merged-to-uat flag, worktree and tickets — to decide what can be cleaned up.',
    inputSchema: { type: 'object', properties: { repo: str('Repo id from Settings (e.g. backend, frontend)') }, required: ['repo'] },
    run: ({ repo }) => {
      if (!Object.hasOwn(gitSettings().repos, repo)) throw httpError(400, `repo must be one of: ${Object.keys(gitSettings().repos).join(', ')}`);
      return gitRead.branches(repo);
    },
  },
  {
    name: 'get_git_job',
    description: 'Status and log of a git job started by run_git_action (waits up to waitSeconds while it runs).',
    inputSchema: { type: 'object', properties: { id: str('Job id'), waitSeconds: { type: 'number', description: 'Default 30' } }, required: ['id'] },
    run: ({ id, waitSeconds = 30 }) => waitJob(String(id), Number(waitSeconds)),
  },

  // --- writes (Settings → MCP → Allow write tools)
  {
    name: 'transition_issue',
    write: true,
    description: 'Move a Jira issue through its workflow. Pass a transition id or name (see list_transitions), or the target status name.',
    inputSchema: { type: 'object', properties: { key: str('Issue key'), transition: str('Transition id, transition name or target status name') }, required: ['key', 'transition'] },
    run: async ({ key, transition }) => {
      key = issueKey(key);
      const want = String(transition || '').trim().toLowerCase();
      const list = await issues.listTransitions(key);
      const t = list.find((x) => x.id === want) || list.find((x) => x.name.toLowerCase() === want) || list.find((x) => x.to?.name.toLowerCase() === want);
      if (!t) throw httpError(400, `No transition "${transition}" for ${key}. Available: ${list.map((x) => `${x.name} → ${x.to?.name}`).join(', ') || 'none'}`);
      const res = await issues.doTransition(key, t.id);
      notifications.invalidate();
      return { key, transition: t.name, status: res.status };
    },
  },
  {
    name: 'create_merge_request',
    write: true,
    description:
      'Open a GitLab merge request the team way (standard title "<KEY>-123: …" and description template with checklist) and return its link. ' +
      'kind: "task-epic" = task branch → epic, "epic-uat" = epic → uat, "develop" = the -develop branch → develop. The source branch must be pushed. ' +
      'Returns the existing MR when one is already open for the same branches.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: str('Repo id'),
        key: str('Issue key'),
        kind: { type: 'string', enum: Object.keys(MR_KINDS) },
        summary: str('1–3 sentences: what and why (English)'),
        changes: { type: 'array', items: { type: 'string' }, description: 'Bullet list of the changes' },
        testCases: { type: 'array', items: { type: 'string' }, description: 'How to verify' },
        title: str('Optional; defaults to the first commit subject "<KEY>-123: …"'),
        draft: { type: 'boolean' },
        epic: str('Epic key when not the Jira parent Epic'),
      },
      required: ['repo', 'key', 'kind'],
    },
    run: (args) => createMergeRequest({ ...args, key: issueKey(args.key), epic: args.epic ? issueKey(args.epic) : undefined }),
  },
  {
    name: 'run_git_action',
    write: true,
    description: [
      'Run one git flow step in the configured repos, the same as the dashboard buttons (backups are taken before rewrites; conflicts are left for the user).',
      'Actions and their params (all take repo unless noted):',
      '- fetch; checkout {branch}; push {branch, force?}; stash-pop {ref}',
      '- ensure-epic {epic}; start-task {key, repos[], branch, epic?, stash?} (no repo; branch <type>/<KEY>-<id>-<desc>-uat)',
      '- create-task {epic, branch}; sync-task {epic, branch} (rebase task onto epic + push); sync-develop {branch (…-develop)} (rebase onto develop + push); rebase-epic {epic}',
      '- pick-develop {branch (…-develop), shas[]}; pick-epic {epic, branch (task …-uat), shas[]} (no merge rights on the epic MR: cherry-pick the task\'s commits straight onto the epic and push, fast-forward only); commit {message "<KEY>-123: …", files[], push?}',
      '- continue / skip / abort {dir?} (continue / skip also do the push the stopped step owed); undo {branch}; delete-branches {branches[]}; prune-backups {days}',
      'Waits for the job up to waitSeconds (default 120) and returns its status and log.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: git.actionNames },
        repo: str('Repo id'),
        params: { type: 'object', description: 'The action params listed above', additionalProperties: true },
        waitSeconds: { type: 'number' },
      },
      required: ['action'],
    },
    run: async ({ action, repo, params, waitSeconds = 120 }) => {
      const job = git.startAction({ ...(params || {}), action, ...(repo ? { repo } : {}) });
      return waitJob(job.id, Number(waitSeconds));
    },
  },
];

const canWrite = () => config.get().mcp.allowWrites;
const PROMPT_START = {
  name: 'start',
  description: 'Plan or implement a Jira ticket: loads its brief (ticket, git state, steps) from the dashboard',
  arguments: [
    { name: 'key', description: 'Issue key, e.g. VLEARN-123', required: true },
    { name: 'mode', description: 'implement (default) or plan' },
    { name: 'repos', description: 'Repo ids, comma separated (default: the first repo)' },
    { name: 'mrs', description: 'MRs to open, comma separated: task-epic, epic-uat, develop (default task-epic)' },
    { name: 'notes', description: 'Anything else Claude should know' },
  ],
};

const visibleTools = () => TOOLS.filter((t) => !t.write || canWrite());

// ---------------------------------------------------------------------------
// JSON-RPC

async function rpc(msg) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'jira-dashboard', version: '1.0.0' },
        instructions:
          `Local Jira dashboard of the signed-in user (site ${config.get().jira.siteUrl}, project key ${gitSettings().key}). ` +
          'To plan or implement a ticket, call task_brief first. Use list_issues / get_issue for tasks and their Confluence docs, git_flow for where a ticket stands in the git flow' +
          (canWrite() ? ', transition_issue, run_git_action and create_merge_request to act.' : '. Write tools are disabled in the dashboard settings.'),
      });
    case 'ping':
      return ok({});
    // In Claude Code: /mcp__jira-dashboard__start VLEARN-123 [implement|plan] [repos]
    case 'prompts/list':
      return ok({ prompts: [PROMPT_START] });
    case 'prompts/get': {
      if (params.name !== PROMPT_START.name) return fail(-32602, `Unknown prompt: ${params.name}`);
      const a = params.arguments || {};
      try {
        const text = prompt.shortPrompt({ key: a.key, mode: a.mode, repos: a.repos, mrKinds: a.mrs, notes: a.notes });
        return ok({ description: PROMPT_START.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
      } catch (e) {
        return fail(-32602, e.message);
      }
    }
    case 'tools/list':
      return ok({ tools: visibleTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = visibleTools().find((t) => t.name === params.name);
      if (!tool) {
        const hidden = TOOLS.some((t) => t.name === params.name);
        return fail(-32602, hidden ? `${params.name} is a write tool; enable it in the dashboard: Settings → MCP → Allow write tools.` : `Unknown tool: ${params.name}`);
      }
      const started = Date.now();
      console.log(`[mcp-server] -> tools/call ${params.name}`, params.arguments ? JSON.stringify(params.arguments) : '{}');
      try {
        const data = await tool.run(params.arguments || {});
        console.log(`[mcp-server] <- ${params.name} ok (${Date.now() - started}ms)`);
        return ok({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
      } catch (e) {
        // Tool failures go back to the model as results it can read and react to.
        console.error(`[mcp-server] <- ${params.name} failed after ${Date.now() - started}ms: ${e.message}`);
        return ok({ content: [{ type: 'text', text: `Error: ${e.name === 'TimeoutError' ? 'Atlassian MCP timed out' : e.message}` }], isError: true });
      }
    }
    default:
      return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
  }
}

// POST /mcp. Only local tools can reach it: the server listens on 127.0.0.1 and checks Host; a page in the browser
// is refused by the Origin check (and JSON bodies can't be sent cross-site without a CORS preflight we never answer).
async function handleMcp(req, res) {
  if (!config.get().mcp.enabled) {
    console.log('[mcp-server] rejected request: MCP disabled in settings');
    return send(res, 404, { error: 'MCP is turned off (Settings → MCP)' });
  }
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    console.warn(`[mcp-server] rejected request: disallowed origin "${origin}"`);
    return send(res, 403, { error: 'Origin not allowed' });
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    return res.end();
  }
  if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Content-Type must be application/json' });
  const body = await readJson(req);
  if (!body) {
    console.warn('[mcp-server] rejected request: JSON parse error');
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const methods = (Array.isArray(body) ? body : [body]).map((m) => m.method).join(', ');
  console.log(`[mcp-server] POST /mcp: ${methods}`);
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map(rpc))).filter(Boolean);
  if (!replies.length) {
    res.writeHead(202);
    return res.end();
  }
  send(res, 200, Array.isArray(body) ? replies : replies[0]);
}

module.exports = { handleMcp };
