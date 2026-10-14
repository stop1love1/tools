'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const TONE_VAR = { new: '--new-dot', prog: '--prog-dot', review: '--review-dot', done: '--done-dot', void: '--new-dot' };
const toneColor = (t) => `var(${TONE_VAR[t] || '--new-dot'})`;

function chartCard(title, hint, body, cls = '') {
  return h('section', { class: `ov-card ${cls}` }, h('h3', null, title), hint && h('p', { class: 'muted small ov-hint' }, hint), body);
}

function emptyChart(text = 'Nothing to show') {
  return h('div', { class: 'ov-empty muted small' }, text);
}

function donutChart(rows, centerLabel) {
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  if (!total) return emptyChart();
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = rows
    .filter((r) => r.n > 0)
    .map((r) => {
      const len = (r.n / total) * C;
      const arc = svg('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: toneColor(r.tone), 'stroke-width': 18, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 70 70)' }, svg('title', null, `${r.name}: ${r.n}`));
      offset += len;
      return arc;
    });
  const chart = svg(
    'svg',
    { viewBox: '0 0 140 140', class: 'ov-donut', role: 'img', 'aria-label': rows.map((r) => `${r.name} ${r.n}`).join(', ') },
    arcs,
    svg('text', { x: 70, y: 68, 'text-anchor': 'middle', class: 'ov-donut-n' }, total),
    svg('text', { x: 70, y: 86, 'text-anchor': 'middle', class: 'ov-donut-l' }, centerLabel),
  );
  const legend = h(
    'ul',
    { class: 'ov-legend' },
    rows.map((r) => h('li', null, h('i', { style: `background:${toneColor(r.tone)}` }), h('span', null, r.name), h('b', null, `${r.n}`), h('span', { class: 'muted' }, `${Math.round((r.n / total) * 100)}%`))),
  );
  return h('div', { class: 'ov-donut-wrap' }, chart, legend);
}

function hBarChart(rows, { color = 'var(--accent)', unit = '' } = {}) {
  const max = Math.max(0, ...rows.map((r) => r.n));
  if (!max) return emptyChart();
  return h(
    'ul',
    { class: 'ov-hbars' },
    rows.map((r) =>
      h(
        'li',
        { title: `${r.name}: ${r.n}${unit}` },
        h('span', { class: 'ov-hbar-name' }, r.name),
        h('span', { class: 'ov-hbar-track' }, h('span', { class: 'ov-hbar-fill', style: `width:${(r.n / max) * 100}%;background:${r.tone ? toneColor(r.tone) : color}` })),
        h('b', null, `${r.n}${unit}`),
      ),
    ),
  );
}

function columnChart(rows, { color = 'var(--accent)', danger = () => false, label = (r) => r.name } = {}) {
  const max = Math.max(0, ...rows.map((r) => r.n));
  if (!max) return emptyChart();
  return h(
    'div',
    { class: 'ov-cols', role: 'img', 'aria-label': rows.map((r) => `${label(r)} ${r.n}`).join(', ') },
    rows.map((r) =>
      h(
        'div',
        { class: 'ov-col', title: `${label(r)}: ${r.n}` },
        h('b', null, r.n || ''),
        h('span', { class: 'ov-col-bar', style: `height:${(r.n / max) * 100}%;background:${danger(r) ? 'var(--danger)' : color}` }),
        h('span', { class: 'ov-col-label' }, label(r)),
      ),
    ),
  );
}

function stackedBars(rows) {
  const max = Math.max(0, ...rows.map((r) => r.new + r.prog + r.done));
  if (!max) return emptyChart();
  const seg = (n, t, name) => n > 0 && h('span', { class: 'ov-seg', style: `width:${(n / max) * 100}%;background:${toneColor(t)}`, title: `${name}: ${n}` });
  return h(
    'ul',
    { class: 'ov-hbars' },
    rows.map((r) =>
      h(
        'li',
        { title: `${r.name}: ${r.new} to do, ${r.prog} in progress, ${r.done} done` },
        h('span', { class: 'ov-hbar-name' }, r.name),
        h('span', { class: 'ov-hbar-track stacked' }, seg(r.new, 'new', 'To Do'), seg(r.prog, 'prog', 'In progress'), seg(r.done, 'done', 'Done')),
        h('b', null, r.new + r.prog + r.done),
      ),
    ),
  );
}

function progressBars(rows, { href } = {}) {
  if (!rows.length) return emptyChart('No tasks under an Epic');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return h(
    'ul',
    { class: 'ov-epics' },
    rows.map((r) => {
      const p = pct(r.done, r.total);
      const name = h(href ? 'a' : 'span', { class: 'ov-epic-name', href: href?.(r), title: r.name }, h('span', { class: 'mono' }, r.key), ' ', r.name);
      return h(
        'li',
        null,
        name,
        h('span', { class: 'ov-hbar-track' }, h('span', { class: 'ov-hbar-fill', style: `width:${p}%;background:var(--done-dot)` })),
        h('b', { title: r.spTotal ? `${r.spDone}/${r.spTotal} SP` : 'No story points' }, `${r.done}/${r.total}`, h('span', { class: 'muted' }, ` ${p}%`)),
      );
    }),
  );
}

function sprintColumns(rows) {
  const max = Math.max(0, ...rows.map((r) => r.spTotal || r.total));
  if (!max) return emptyChart();
  const useSP = rows.some((r) => r.spTotal > 0);
  const val = (r, key) => (useSP ? r[key === 'total' ? 'spTotal' : 'spDone'] : r[key === 'total' ? 'total' : 'done']);
  return h(
    'div',
    { class: 'ov-cols pair', role: 'img', 'aria-label': rows.map((r) => `${r.name}: ${val(r, 'done')} of ${val(r, 'total')}`).join(', ') },
    rows.map((r) =>
      h(
        'div',
        { class: 'ov-col', title: `${r.name}: ${val(r, 'done')} done of ${val(r, 'total')} ${useSP ? 'SP' : 'tasks'}` },
        h('b', null, `${val(r, 'done')}/${val(r, 'total')}`),
        h('span', { class: 'ov-pair' }, h('span', { class: 'ov-col-bar', style: `height:${(val(r, 'total') / max) * 100}%;background:var(--prog-dot)` }), h('span', { class: 'ov-col-bar', style: `height:${(val(r, 'done') / max) * 100}%;background:var(--done-dot)` })),
        h('span', { class: 'ov-col-label' }, r.name.replace(/^.*?(Sprint\s*\d+).*$/i, '$1')),
      ),
    ),
  );
}

function lineChart(b) {
  if (!b) return emptyChart('The selected sprint has no start and end date');
  const W = 560;
  const H = 200;
  const pad = { l: 34, r: 12, t: 12, b: 24 };
  const x = (d) => pad.l + (d / b.length) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (b.total ? v / b.total : 0)) * (H - pad.t - pad.b);
  const path = (key) => b.points.filter((p) => p[key] != null).map((p, k) => `${k ? 'L' : 'M'}${x(b.points.indexOf(p)).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const ticks = [0, 0.5, 1].map((f) => b.total * f);
  const every = Math.max(1, Math.ceil(b.length / 7));
  return svg(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'ov-line', role: 'img', 'aria-label': `Burndown in ${b.unit}: ${b.total} planned` },
    ticks.map((t) => svg('g', null, svg('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'ov-grid' }), svg('text', { x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'ov-axis' }, Math.round(t)))),
    b.points.map((p, d) => d % every === 0 && svg('text', { x: x(d), y: H - 6, 'text-anchor': 'middle', class: 'ov-axis' }, p.date.slice(5).replace('-', '/'))),
    svg('path', { d: path('ideal'), class: 'ov-line-ideal' }),
    svg('path', { d: path('actual'), class: 'ov-line-actual' }),
    svg('line', { x1: x(b.today), x2: x(b.today), y1: pad.t, y2: H - pad.b, class: 'ov-today' }),
  );
}

function kpiCard(label, value, { sub, tone: t, title } = {}) {
  return h('div', { class: `ov-kpi${t ? ` ${t}` : ''}`, title }, h('span', { class: 'ov-kpi-label' }, label), h('b', { class: 'ov-kpi-value' }, value), sub && h('span', { class: 'ov-kpi-sub muted small' }, sub));
}

function taskList(title, hint, issues, { limit = 8, extra } = {}) {
  const shown = issues.slice(0, limit);
  const body = shown.length
    ? h(
        'ul',
        { class: 'ov-tasks' },
        shown.map((i) =>
          h(
            'li',
            null,
            typeBadge(i.type.name),
            h('button', { class: 'link-btn mono', title: 'Open in the task list', onClick: () => openIssueChip(i.key) }, i.key),
            h('span', { class: 'ov-task-title', title: i.summary }, i.summary),
            extra?.(i),
            dueBadge(i),
            h('span', { class: `gchip tone-${tone(i.status)}` }, i.status.name),
          ),
        ),
        issues.length > limit && h('li', { class: 'muted small' }, `+ ${issues.length - limit} more`),
      )
    : emptyChart('Nothing here');
  return chartCard(`${title} (${issues.length})`, hint, body, 'wide');
}
