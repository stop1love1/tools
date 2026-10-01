'use strict';

// "Copy for AI" and the Claude Code button.

// ---------------------------------------------------------------------------
// Copy for AI

function htmlToText(html, site) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = new URL(a.getAttribute('href'), site + '/').href;
    if (a.textContent.trim() !== href) a.append(` (${href})`);
  }
  for (const li of doc.querySelectorAll('li')) li.prepend('- ');
  for (const el of doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,br,pre')) el.append('\n');
  return doc.body.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function issueMarkdown(i, d) {
  const site = siteOf(i);
  const docs = d?.issue?.docs?.length ? d.issue.docs : i.docs;
  const extraDocs = d?.confluence || [];
  const L = [
    `## ${i.key}: ${i.summary}`,
    `- Jira: ${i.url}`,
    `- Status: ${i.status.name} · Type: ${i.type.name} · Priority: ${i.priority || '—'}${i.due ? ` · Due: ${i.due}` : ''}`,
  ];
  const reasons = urgency(i).reasons;
  if (reasons.length) L.push(`- Needs attention: ${reasons.map((r) => r.label).join(', ')}`);
  if (i.parent) L.push(`- Parent: ${i.parent.key} ${i.parent.summary} — ${site}/browse/${i.parent.key}`);
  const allDocs = [...docs, ...extraDocs.filter((x) => !docs.some((y) => (y.pageId || y.url) === (x.pageId || x.url)))];
  if (allDocs.length) {
    L.push('- Confluence docs:');
    for (const x of allDocs) L.push(`  - ${docTitle(x)}: ${x.url}`);
  }
  if (i.attachments.length) {
    L.push('- Attachments:');
    for (const a of i.attachments) L.push(`  - ${a.filename}: ${a.url}`);
  }
  if (d) {
    const mrs = d.links.filter((l) => l.kind === 'mr');
    if (mrs.length) {
      L.push('- Merge request:');
      for (const l of mrs) L.push(`  - ${l.title}: ${l.url}`);
    }
    if (d.children.length) {
      L.push('- Task con:');
      for (const c of d.children) L.push(`  - ${c.key} [${c.status?.name || ''}] ${c.summary} — ${site}/browse/${c.key}`);
    }
    const desc = htmlToText(d.descriptionHtml, site);
    if (desc) L.push('', '### Description', desc);
    if (d.comments.length) {
      L.push('', '### Comments');
      for (const c of d.comments) L.push(`- ${c.author} (${fmtDate(c.created)}): ${htmlToText(c.html, site).replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  return L.join('\n');
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(message);
}

const claudePrompt = (i, d) =>
  `Read the Jira task below (use Atlassian MCP to view details and related Confluence docs):\n\n${issueMarkdown(i, d)}`.slice(0, 11_000);

// Opens a new Claude Code tab in Cursor with the task prefilled. An already-open session can't take a
// prompt from outside, so the same text also goes to the clipboard for pasting there.
// prompt: a ready prompt (the "Open in Cursor" mode of the Start dialog); default: the ticket as Markdown.
async function sendToClaude(i, d, prompt = claudePrompt(i, d)) {
  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    // Clipboard unavailable: the new tab still gets the prompt.
  }
  try {
    await api('/api/claude-code', { method: 'POST', body: JSON.stringify({ prompt }) });
    toast(`Opened ${i.key} in Claude Code (Cursor). Content also copied to paste into the open session.`);
  } catch (e) {
    toast(`Failed to open Claude Code: ${e.message}. Content copied — paste manually.`, 'error');
  }
}

// The Claude button of a task row: the Start dialog (its Start opens Claude Code in Cursor with the prompt,
// built server-side by task_brief/MCP). Works the same for a task, story or epic — an epic just has no task
// branch of its own, so its dialog defaults to the epic → uat MR kind instead of task → epic (see start.js).
function claudeButton(i) {
  return h(
    'button',
    {
      class: 'icon-btn sm claude-btn',
      title: 'Start with Claude: choose repos / MRs, then open Claude Code in Cursor',
      'aria-label': `Claude for ${i.key}`,
      onClick: (e) => {
        e.stopPropagation();
        startWithClaude(i);
      },
    },
    icon('ai'),
  );
}
