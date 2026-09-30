'use strict';

// "Start with Claude", MCP style. The chat gets a short prompt (shortPrompt): "call task_brief with these options".
// The task_brief MCP tool (brief) then returns everything in one go: the ticket (description, comments, sub-tasks,
// Confluence pages, MRs), its git state in the chosen repos, and the steps for the chosen options — so the context
// comes from the server, fresh, instead of being pasted into the chat.

const config = require('./config');
const issues = require('./issues');
const gitRead = require('./git/read');
const { settings: gitSettings } = require('./git/settings');
const { MR_KINDS } = require('./git/merge-requests');
const { httpError, htmlToText } = require('./util');

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const DESC_MAX = 6000;
const COMMENTS_MAX = 8;

function validate(opts = {}) {
  const s = gitSettings();
  const key = String(opts.key || '').trim().toUpperCase();
  if (!KEY_RE.test(key)) throw httpError(400, 'Invalid issue key');
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []).filter(Boolean);
  const repos = list(opts.repos).filter((r) => Object.hasOwn(s.repos, r));
  const mode = opts.mode === 'plan' ? 'plan' : 'implement';
  const mrKinds = mode === 'plan' ? [] : list(opts.mrKinds ?? ['task-epic']).filter((k) => Object.hasOwn(MR_KINDS, k));
  return {
    key,
    mode,
    repos: repos.length ? repos : Object.keys(s.repos).slice(0, 1),
    mrKinds,
    draft: opts.draft === true || opts.draft === 'true',
    moveStatus: mode !== 'plan' && opts.moveStatus !== false && opts.moveStatus !== 'false',
  };
}

// What goes into the chat: the options as task_brief arguments, plus the user's notes.
function shortPrompt(opts) {
  const o = validate(opts);
  const notes = String(opts.notes || '').slice(0, 4000).trim();
  return [
    `${o.mode === 'plan' ? 'Plan' : 'Implement'} Jira ${o.key} with the jira-dashboard MCP.`,
    `Start by calling task_brief ${JSON.stringify(o)} — it returns the ticket, its git state and the steps; follow them.`,
    ...(notes ? ['', `My notes: ${notes}`] : []),
  ].join('\n');
}

// The steps for the options (numbered, short). Write tools off → the same rules, done with git / glab by hand.
function steps(o) {
  const s = gitSettings();
  const writes = config.get().mcp.allowWrites;
  const extra = config.get().agent.extraInstructions;
  const t = (withTool, byHand) => (writes ? withTool : byHand);
  const common = [
    'Read the linked Confluence pages that matter (get_confluence_page) and the relevant code. Ask me when something important is unclear.',
    "Follow each repo's own rules and style (CLAUDE.md, AGENTS.md, .cursor/rules, nearby code); keep to what the ticket asks.",
  ];
  if (o.mode === 'plan') {
    return [...common, 'Plan only — change nothing. Reply with: files to change per repo and how, approach, risks / open questions, test cases, branch name.', ...extra];
  }
  const branch = `<type>/${o.key}-<short-english-slug>-${s.uat}`;
  const list = [
    ...common,
    o.moveStatus && `Move ${o.key} to an "In Development"-like status${t(' (list_transitions, transition_issue)', '')}.`,
    t(
      `Branch: reuse the task branch below, or run_git_action start-task { key: "${o.key}", repos, branch: "${branch}", stash: true } (makes the epic from ${s.uat} if missing).`,
      `Branch: reuse the task branch below, or create "${branch}" from origin/<epic branch> (the epic from origin/${s.uat} if missing); stash my work first.`,
    ),
    'Implement; run the lint / typecheck / tests that cover what you touched.',
    t(
      `Commit and push with run_git_action (commit, push): message "${o.key}: <what changed, in English>", no Co-authored-by. Hooks run lint / typecheck — fix and retry on failure.`,
      `Commit "${o.key}: <what changed, in English>" (no Co-authored-by) and push; never force-push without asking.`,
    ),
    ...(o.mrKinds.includes('develop')
      ? [t(`Cherry-pick the ticket's commits to the -${s.develop} twin of the task branch: run_git_action pick-develop { repo, branch, shas }.`, `Cherry-pick the ticket's commits (no merges) onto the -${s.develop} twin of the task branch, made from origin/${s.develop}.`)]
      : []),
    o.mrKinds.length
      ? t(
          `Open the MRs with create_merge_request { repo, key, kind, summary, changes, testCases${o.draft ? ', draft: true' : ''} } — kinds: ${o.mrKinds.join(', ')}.`,
          `Open the MRs${o.draft ? ' as drafts' : ''} (${o.mrKinds.map((k) => MR_KINDS[k]).join('; ')}), title "${o.key}: <summary>", description: Summary / Changes / Test cases / Checklist.`,
        )
      : 'Do not open merge requests.',
    o.moveStatus && o.mrKinds.length && `Move ${o.key} to a review status ("In Review" / "Code Review").`,
    ...extra,
    'Finish with a short report: changes per repo, checks run, assumptions, MR links.',
  ];
  return list.filter(Boolean);
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (truncated — get_issue has the full text)` : text);

// task_brief: ticket + git state + steps, as compact Markdown.
async function brief(opts) {
  const o = validate(opts);
  const s = gitSettings();
  const [d, f] = await Promise.all([issues.issueDetail(o.key), gitRead.flow(o.key, null).catch((e) => ({ error: e.message }))]);
  const i = d.issue;
  const L = [
    `# ${i.key}: ${i.summary}`,
    [`${i.type.name}`, i.status?.name, i.priority && `priority ${i.priority}`, i.due && `due ${i.due}`, i.sprint?.name, i.storyPoints && `${i.storyPoints} SP`].filter(Boolean).join(' · '),
    [i.parent && `Parent: ${i.parent.key} ${i.parent.summary}`, f.epic && `Epic branch: epic/${f.epic}`, d.assignee && `Assignee: ${d.assignee}`].filter(Boolean).join(' · '),
    i.url,
    '',
    '## Description',
    clip(htmlToText(d.descriptionHtml) || '(none)', DESC_MAX),
  ];
  // A sub-task often says little itself: the parent's description carries the context.
  const own = htmlToText(d.descriptionHtml);
  if (i.parent && own.length < 300) {
    const p = await issues.issueDetail(i.parent.key).catch(() => null);
    const text = p && htmlToText(p.descriptionHtml);
    if (text) L.push('', `## Parent ${i.parent.key}: ${i.parent.summary}`, clip(text, DESC_MAX));
  }
  const docs = [...i.docs, ...d.confluence].filter((x, n, a) => a.findIndex((y) => (y.pageId || y.url) === (x.pageId || x.url)) === n);
  if (docs.length) L.push('', '## Confluence', ...docs.map((x) => `- ${x.title || x.url}${x.pageId ? ` (pageId ${x.pageId})` : ''}${x.from && x.from !== i.key ? ` — from ${x.from}` : ''}`));
  if (d.children.length) L.push('', '## Sub-tasks', ...d.children.map((c) => `- ${c.key} [${c.status?.name}] ${c.summary}`));
  const mrs = d.links.filter((l) => l.kind === 'mr');
  if (mrs.length) L.push('', '## MRs on Jira', ...mrs.map((l) => `- ${l.title}: ${l.url}`));
  if (i.attachments.length) L.push('', '## Attachments', ...i.attachments.map((a) => `- ${a.filename}: ${a.url}`));
  if (d.comments.length) {
    const recent = d.comments.slice(-COMMENTS_MAX);
    L.push('', `## Comments${d.comments.length > recent.length ? ` (last ${recent.length} of ${d.comments.length})` : ''}`);
    for (const c of recent) L.push(`- ${c.author} (${c.created.slice(0, 10)}): ${clip(htmlToText(c.html).replace(/\s*\n\s*/g, ' '), 800)}`);
  }

  L.push('', '## Git');
  if (f.error) L.push(`(git state unavailable: ${f.error})`);
  for (const repo of o.repos) {
    const r = f.repos?.[repo];
    if (!r) continue;
    if (r.error) {
      L.push(`- ${repo}: ${r.error}`);
      continue;
    }
    const b = (x) => (x ? `${x.name}${x.remote ? '' : ' (local only)'}${x.sync?.onlyA ? ` (${x.sync.onlyA} to push)` : ''}` : 'none');
    L.push(
      `- ${repo} (${s.repos[repo]}): checked out ${r.current || 'detached'}${r.dirty ? `, ${r.dirty} uncommitted file(s)` : ''}${r.op ? `, ${r.op} in progress` : ''}`,
      `  epic ${r.epic.name}${r.epic.remote ? '' : ' (not on origin yet)'} · task ${b(r.uat)} · develop ${b(r.develop)} · ${r.commits?.length || 0} ${o.key} commit(s)`,
    );
    if (r.otherBranches?.length) L.push(`  also names ${o.key} (non-standard): ${r.otherBranches.join(', ')}`);
  }

  L.push('', `## Steps (${o.mode === 'plan' ? 'plan only' : `implement; MRs: ${o.mrKinds.join(', ') || 'none'}`})`, ...steps(o).map((x, n) => `${n + 1}. ${x}`));
  return L.join('\n');
}

module.exports = { shortPrompt, brief, validate };
