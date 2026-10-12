'use strict';

const config = require('./config');
const issues = require('./issues');
const notifications = require('./notifications');
const gitRead = require('./git/read');
const git = require('./git');
const { getJob, listJobs } = require('./git/jobs');
const { settings: gitSettings } = require('./git/settings');
const { createMergeRequest, MR_KINDS } = require('./git/merge-requests');
const { callTool } = require('./mcp');
const prompt = require('./prompt');
const { isAuthorized, FILE: TOKEN_FILE } = require('./mcp-token');
const { httpError, send, readJson, htmlToText, ISSUE_KEY_RE } = require('./util');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_OUTPUT = 60_000; // characters of one tool result; longer ones are cut with a note
const JOB_WAIT_DEFAULT = 20; // seconds run_git_action waits before handing back a still-running job id

// run_git_action steps that rewrite or delete history / refs: they need "Allow destructive git steps" on top of "Allow write tools".
const DESTRUCTIVE_ACTIONS = new Set(['sync-task', 'sync-develop', 'rebase-epic', 'undo', 'delete-branches', 'prune-backups']);
const isDestructive = (action, params) => DESTRUCTIVE_ACTIONS.has(action) || (action === 'push' && !!params?.force);

const issueKey = (k) => {
  const key = String(k || '').trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(key)) throw httpError(400, `Invalid issue key "${k}" (expected e.g. ${gitSettings().key}-123)`);
  return key;
};

// Dashboard-relative links (attachments) are useless to an MCP client: make them absolute.
const dashboardUrl = (rel) => (rel.startsWith('/') ? `http://localhost:${config.startupValue('server.port')}${rel}` : rel);

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

async function waitJob(id, waitSeconds = 120) {
  const until = Date.now() + Math.min(Math.max(waitSeconds, 0), 600) * 1000;
  let job = getJob(id);
  while (job && job.status === 'running' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    job = getJob(id);
  }
  if (!job) throw httpError(404, 'Job not found');
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    ...(job.status === 'running' ? { note: 'Still running: call get_git_job with this id to wait for it. Do not start the same step again.' } : {}),
    error: job.error,
    result: job.result,
    log: job.log.join('\n').slice(-12_000),
  };
}

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
        mrKinds: { type: 'array', items: { type: 'string', enum: Object.keys(MR_KINDS) }, description: 'MRs to open (default: epic-uat; the task reaches the epic by pick-epic, not by an MR)' },
        draft: { type: 'boolean' },
        moveStatus: { type: 'boolean', description: 'Move the Jira status along (default true)' },
        writes: {
          type: 'boolean',
          description:
            'false (default): tell me the steps instead and do nothing by hand without asking first. ' +
            'true: use the write tools yourself (transition_issue, run_git_action, create_merge_request) — only when I asked for it. Has no effect if write tools are off in Settings → MCP.',
        },
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
      const max = Math.max(1, Math.min(Number(limit) || 100, 300));
      // The search itself stops at Settings → Max issues per load, so a full page may hide more.
      const capped = list.length >= config.get().jira.maxIssues;
      return { jql: q, total: list.length, truncated: list.length > max || capped, issues: list.slice(0, max).map(issueRow) };
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
        attachments: d.issue.attachments.map((a) => ({ filename: a.filename, size: a.size, url: dashboardUrl(a.url) })),
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
    needsToken: true, // job logs carry git / pre-commit hook output
    description: 'Status and log of a git job started by run_git_action (waits up to waitSeconds while it runs).',
    inputSchema: { type: 'object', properties: { id: str('Job id'), waitSeconds: { type: 'number', description: 'Default 30' } }, required: ['id'] },
    run: ({ id, waitSeconds = 30 }) => waitJob(String(id), Number(waitSeconds)),
  },
  {
    name: 'list_git_jobs',
    needsToken: true,
    description: 'Recent git jobs (newest first) with id, title, repo and status — to find a job whose id you did not receive (e.g. run_git_action timed out on the client side).',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ jobs: listJobs() }),
  },

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
      'Open a GitLab merge request the team way (title "<KEY>-123: <commit subject>" — the same for epic-uat and develop — and the description template with checklist) and return its link. ' +
      'kind: "epic-uat" = epic → uat, "develop" = the -develop branch → develop; "task-epic" (task → epic) is legacy: put the task into the epic with run_git_action pick-epic instead. The source branch must be pushed. ' +
      'Returns the existing MR when one is already open for the same branches. ' +
      'checklist: tick only what you really checked, each with a short note (shown after "—"); items not listed stay [ ]. Use the same title, summary and changes for the uat and develop MRs; only the Build note differs (the command run on each branch). ' +
      'testCases: plain strings stay [ ]; pass {text, checked: true, note} only when you really called the API or tested by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: str('Repo id'),
        key: str('Issue key'),
        kind: { type: 'string', enum: Object.keys(MR_KINDS) },
        summary: str('1–3 sentences: what and why (English)'),
        changes: { type: 'array', items: { type: 'string' }, description: 'Bullet list of the changes' },
        testCases: {
          type: 'array',
          description: 'How to verify. A string = not run yet ([ ]); an object ticks it only with proof of a real API call / manual test.',
          items: {
            anyOf: [
              { type: 'string' },
              { type: 'object', properties: { text: str('The test case'), checked: { type: 'boolean' }, note: str('What was called / tried, and the result') }, required: ['text'] },
            ],
          },
        },
        checklist: {
          type: 'array',
          description: 'Checklist items you really checked: [{ item: <number or text of a configured item>, note: <short note>, checked?: true }]',
          items: {
            type: 'object',
            properties: { item: { description: '1-based number, or (part of) the item text' }, note: str('Short note shown after "—", e.g. "uat npm run build pass"'), checked: { type: 'boolean', description: 'default true; false = leave [ ] but keep the note' } },
            required: ['item', 'note'],
          },
        },
        title: str('Optional; defaults to the first commit subject "<KEY>-123: …" (same for every kind)'),
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
      '- pick-develop {branch (…-develop), shas[]}; pick-epic {epic, branch (task …-uat), shas[]} (how a task gets into the epic, instead of an MR task → epic: cherry-pick the task\'s commits straight onto the epic and push, fast-forward only; the log ends with a git cherry check — no "+" line = fully on the epic); commit {message "<KEY>-123: …", files[], push?, skip?[] (pre-commit hook ids to skip, passed as SKIP=; only for a hook failing for reasons unrelated to the change, e.g. npm-audit / trivy-fs)}',
      '- continue / skip / abort {dir?} (continue / skip also do the push the stopped step owed); undo {branch}; delete-branches {branches[]}; prune-backups {days}',
      `Waits for the job up to waitSeconds (default ${JOB_WAIT_DEFAULT}) and returns its status and log; a job still running then comes back with status "running" and its id: follow it with get_git_job.`,
      'Destructive steps (sync-task, sync-develop, rebase-epic, undo, delete-branches, prune-backups, push with force) are refused unless "Allow destructive git steps" is on in Settings → MCP.',
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
    run: async ({ action, repo, params, waitSeconds = JOB_WAIT_DEFAULT }) => {
      if (isDestructive(action, params) && !config.get().mcp.allowDestructive) {
        throw httpError(403, `"${action}" rewrites or deletes history; enable it in the dashboard: Settings → MCP → Allow destructive git steps.`);
      }
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
    { name: 'mrs', description: 'MRs to open, comma separated: epic-uat, develop (default epic-uat; task-epic is legacy)' },
    { name: 'writes', description: 'true to use the write tools yourself end-to-end; default false: tell me the steps instead' },
    { name: 'notes', description: 'Anything else Claude should know' },
  ],
};

const visibleTools = () => TOOLS.filter((t) => !t.write || canWrite());

// Hints for MCP clients (Cursor, Claude Code): auto-approve reads, ask before writes, warn on run_git_action.
const annotations = (t) => ({
  readOnlyHint: !t.write,
  ...(t.write ? { destructiveHint: t.name === 'run_git_action', idempotentHint: false } : {}),
  openWorldHint: t.name !== 'git_overview' && !t.name.startsWith('git_branches'),
});

// Compact JSON, cut at MAX_OUTPUT so one huge page or issue cannot flood the model's context.
function render(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (truncated: ${text.length - MAX_OUTPUT} more characters; narrow the request)` : text;
}

async function rpc(msg, { authorized = false } = {}) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg && typeof msg === 'object' ? (msg.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } };
  }
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
    case 'prompts/list':
      return ok({ prompts: [PROMPT_START] });
    case 'prompts/get': {
      if (params.name !== PROMPT_START.name) return fail(-32602, `Unknown prompt: ${params.name}`);
      const a = params.arguments || {};
      try {
        const text = prompt.shortPrompt({ key: a.key, mode: a.mode, repos: a.repos, mrKinds: a.mrs, writes: a.writes, notes: a.notes });
        return ok({ description: PROMPT_START.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
      } catch (e) {
        return fail(-32602, e.message);
      }
    }
    case 'tools/list':
      return ok({ tools: visibleTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: annotations(t) })) });
    case 'tools/call': {
      const tool = visibleTools().find((t) => t.name === params.name);
      if (!tool) {
        const hidden = TOOLS.some((t) => t.name === params.name);
        return fail(-32602, hidden ? `${params.name} is a write tool; enable it in the dashboard: Settings → MCP → Allow write tools.` : `Unknown tool: ${params.name}`);
      }
      if ((tool.write || tool.needsToken) && !authorized) {
        console.warn(`[mcp-server] refused ${params.name}: missing or wrong bearer token`);
        return fail(-32001, `${params.name} needs the dashboard token: send "Authorization: Bearer <contents of ${TOKEN_FILE}>" (see README → MCP).`);
      }
      const started = Date.now();
      console.log(`[mcp-server] -> tools/call ${params.name}`, params.arguments ? JSON.stringify(params.arguments) : '{}');
      try {
        const data = await tool.run(params.arguments || {});
        console.log(`[mcp-server] <- ${params.name} ok (${Date.now() - started}ms)`);
        return ok({ content: [{ type: 'text', text: render(data) }] });
      } catch (e) {
        console.error(`[mcp-server] <- ${params.name} failed after ${Date.now() - started}ms: ${e.message}`);
        return ok({ content: [{ type: 'text', text: `Error: ${e.name === 'TimeoutError' ? 'Atlassian MCP timed out' : e.message}` }], isError: true });
      }
    }
    default:
      return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
  }
}

async function handleMcp(req, res) {
  if (!config.get().mcp.enabled) {
    console.log('[mcp-server] rejected request: MCP disabled in settings');
    return send(res, 404, { error: 'MCP is turned off (Settings → MCP)' });
  }
  const origin = req.headers.origin;
  const port = config.startupValue('server.port');
  if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) {
    console.warn(`[mcp-server] rejected request: disallowed origin "${origin}"`);
    return send(res, 403, { error: 'Origin not allowed' });
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    return res.end();
  }
  if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Content-Type must be application/json' });
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, e.status || 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: e.message } });
  }
  if (!body || (Array.isArray(body) && !body.length)) {
    console.warn('[mcp-server] rejected request: JSON parse error');
    return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const messages = Array.isArray(body) ? body : [body];
  const authorized = isAuthorized(req);
  console.log(`[mcp-server] POST /mcp: ${messages.map((m) => m?.method).join(', ')}`);
  const replies = (await Promise.all(messages.map((m) => rpc(m, { authorized })))).filter(Boolean);
  if (!replies.length) {
    res.writeHead(202);
    return res.end();
  }
  send(res, 200, Array.isArray(body) ? replies : replies[0]);
}

module.exports = { handleMcp };
