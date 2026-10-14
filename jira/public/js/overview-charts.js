'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const fmtNum = (n) => (Number.isInteger(n) ? n : n.toFixed(1));

function card(title, hint, body, { label = title, cls = '' } = {}) {
  return h('section', { class: `ov-card ${cls}`, 'aria-label': label }, h('div', { class: 'ov-card-head' }, h('h3', null, title), hint && h('span', { class: 'muted small' }, hint)), body);
}

function emptyChart(text = 'Nothing to show') {
  return h('div', { class: 'ov-empty muted small' }, text);
}

// Top strip: sprint name and dates, days left, and one bar split into done / in progress / to do.
function sprintCard(sprint, p, pace, taskCount) {
  const pct = (n) => (p.total ? (n / p.total) * 100 : 0);
  const dates = sprint?.startDate && sprint?.endDate ? `${fmtDay(sprint.startDate.slice(0, 10))} → ${fmtDay(sprint.endDate.slice(0, 10))} · ` : '';
  const legend = (tone, label, n) => h('span', null, h('i', { style: `background:var(--${tone}-dot)` }), `${label} ${fmtNum(n)} ${p.unit}`);
  return h(
    'section',
    { class: 'ov-card ov-sprint', 'aria-label': 'Sprint progress' },
    h('div', null, h('h2', { class: 'ov-sprint-name' }, sprint ? sprint.name : 'All sprints'), h('div', { class: 'muted small' }, `${dates}${fmtNum(p.total)} ${p.unit} planned · ${taskCount} tasks`)),
    p.daysLeft != null && h('div', { class: 'ov-days-left' }, h('b', null, p.daysLeft), h('span', { class: 'muted small' }, p.daysLeft === 1 ? 'day left' : 'days left')),
    h(
      'div',
      { class: 'ov-bar', role: 'img', 'aria-label': `Done ${Math.round(pct(p.done))}%, in progress ${Math.round(pct(p.prog))}%, to do ${Math.round(pct(p.todo))}%` },
      h('span', { style: `width:${pct(p.done)}%;background:var(--done-dot)` }),
      h('span', { style: `width:${pct(p.prog)}%;background:var(--prog-dot)` }),
    ),
    h(
      'div',
      { class: 'ov-legend' },
      legend('done', 'Done', p.done),
      legend('prog', 'In progress', p.prog),
      legend('new', 'To do', p.todo),
      pace && h('span', { class: 'ov-pace' }, pace.behind > 0 ? h('b', { class: 'warn' }, `Behind plan by ${fmtNum(pace.behind)} ${p.unit}`) : h('b', { class: 'ok' }, 'On track')),
    ),
  );
}

function statCard(label, value, { sub, tone: t } = {}) {
  return h('div', { class: `ov-card ov-stat${t ? ` ${t}` : ''}` }, h('span', { class: 'ov-stat-label' }, label), h('b', { class: 'ov-stat-value' }, value), sub && h('span', { class: 'muted small' }, sub));
}

function taskRow(i, when) {
  return h(
    'li',
    { class: 'ov-row', title: 'Open in the task list', onClick: () => openIssueChip(i.key) },
    typeBadge(i.type.name),
    h('span', { class: 'mono ov-key' }, i.key),
    h('span', { class: 'ov-task-title', title: i.summary }, i.summary),
    h('span', { class: `gchip tone-${tone(i.status)}` }, i.status.name),
    h('span', { class: 'ov-when' }, when),
  );
}

// One list, grouped by why each task needs a look. A group with nothing in it is left out.
function attentionCard(groups, { limit = 6 } = {}) {
  const total = groups.reduce((n, g) => n + g.issues.length, 0);
  const body = total
    ? groups
        .filter((g) => g.issues.length)
        .map((g) =>
          h(
            'div',
            { class: `ov-group${g.tone ? ` ${g.tone}` : ''}` },
            h('div', { class: 'ov-group-title' }, g.title, h('span', { class: 'ov-count' }, g.issues.length)),
            h('ul', { class: 'ov-rows' }, g.issues.slice(0, limit).map((i) => taskRow(i, g.when(i))), g.issues.length > limit && h('li', { class: 'muted small ov-more' }, `+ ${g.issues.length - limit} more`)),
          ),
        )
    : emptyChart('Nothing overdue, due soon or idle — all clear.');
  return card('Needs attention', total ? `${total} tasks · soonest first` : null, body, { cls: 'ov-attention' });
}

function burndownChart(b) {
  if (!b) return emptyChart('The selected sprint has no start and end date');
  const W = 320;
  const H = 160;
  const pad = { l: 28, r: 8, t: 10, b: 22 };
  const x = (d) => pad.l + (d / b.length) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (b.total ? v / b.total : 0)) * (H - pad.t - pad.b);
  const path = (key) => b.points.filter((p) => p[key] != null).map((p, k) => `${k ? 'L' : 'M'}${x(b.points.indexOf(p)).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const ticks = [0, 0.5, 1].map((f) => b.total * f);
  const today = Math.max(0, b.today);
  const last = b.points[b.points.length - 1];
  return svg(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'ov-line', role: 'img', 'aria-label': `Burndown in ${b.unit}: ${b.total} planned` },
    ticks.map((t) => svg('g', null, svg('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'ov-grid' }), svg('text', { x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'ov-axis' }, Math.round(t)))),
    svg('text', { x: x(0), y: H - 4, class: 'ov-axis' }, fmtDay(b.points[0].date)),
    svg('text', { x: x(b.length), y: H - 4, 'text-anchor': 'end', class: 'ov-axis' }, fmtDay(last.date)),
    svg('path', { d: path('ideal'), class: 'ov-line-ideal' }),
    svg('path', { d: path('actual'), class: 'ov-line-actual' }),
    b.today >= 0 && b.today <= b.length && svg('line', { x1: x(today), x2: x(today), y1: pad.t, y2: H - pad.b, class: 'ov-today' }),
  );
}

function burndownCard(b, pace) {
  if (pace && !pace.left) return card('Burndown', `${b.unit} remaining`, [burndownChart(b), h('p', { class: 'ov-note muted small' }, h('b', { class: 'ok' }, 'All planned work is done.'))]);
  const note =
    pace &&
    h(
      'p',
      { class: 'ov-note muted small' },
      `${fmtNum(pace.left)} ${b.unit} left, ideal is ${fmtNum(pace.ideal)}`,
      pace.perDay != null && [' — ', h('b', { class: pace.behind > 0 ? 'warn' : '' }, `needs ~${fmtNum(pace.perDay)} ${b.unit}/day`), ' to finish on time.'],
    );
  return card('Burndown', b ? `${b.unit} remaining` : null, [burndownChart(b), note]);
}

function epicsCard(rows, { href, limit = 6 } = {}) {
  if (!rows.length) return card('Epics', null, emptyChart('No tasks under an Epic'));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return card(
    'Epics',
    'done / total',
    h(
      'ul',
      { class: 'ov-epics' },
      rows.slice(0, limit).map((r) =>
        h(
          'li',
          null,
          h('a', { class: 'ov-epic-name', href: href(r), title: `${r.key} ${r.name}` }, r.name),
          h('b', { title: r.spTotal ? `${r.spDone}/${r.spTotal} SP` : 'No story points' }, `${r.done} / ${r.total}`),
          h('span', { class: 'ov-track' }, h('span', { style: `width:${pct(r.done, r.total)}%` })),
        ),
      ),
      rows.length > limit && h('li', { class: 'muted small' }, `+ ${rows.length - limit} more`),
    ),
  );
}

// ---- Trends: stacked lanes on one shared time axis. Each lane keeps its own y-scale (tasks, days, %), so no
// line is squashed and there is never a second y-axis; one crosshair and one tooltip read every lane at once.

const niceMax = (v) => {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v);
};

function trendChart(slots, lanes, { lane: LANE = 72 } = {}) {
  const W = 1090;
  const GAP = 42;
  const pad = { l: 40, r: 10, t: 22, b: 24 };
  const H = pad.t + lanes.length * LANE + (lanes.length - 1) * GAP + pad.b;
  const n = slots.length;
  const band = (W - pad.l - pad.r) / n;
  const cx = (k) => pad.l + band * (k + 0.5);
  const every = Math.ceil(n / 10);
  const plotBottom = H - pad.b;

  const parts = lanes.map((lane, li) => {
    const top0 = pad.t + li * (LANE + GAP);
    const drawn = lane.series.filter((se) => !se.hidden);
    const vals = slots.flatMap((s) => drawn.map((se) => s[se.key])).filter((v) => v != null);
    const top = lane.max ?? niceMax(Math.max(1, ...vals));
    const y = (v) => top0 + (1 - v / top) * LANE;
    const fmt = lane.fmt || ((v) => v);
    const g = [
      // Lane title and its series key, above the lane.
      lane.title && svg('text', { x: pad.l, y: top0 - 9, class: 'ov-lane-title' }, lane.title),
      ...(drawn.length < 2 ? [] : drawn).flatMap((se, j) => {
        const x = pad.l + (lane.title ? 120 : 0) + j * 150;
        return [svg('line', { x1: x, x2: x + 12, y1: top0 - 13, y2: top0 - 13, stroke: se.color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-dasharray': se.dash ? '3 3' : null }), svg('text', { x: x + 17, y: top0 - 9, class: 'ov-axis' }, se.label)];
      }),
      ...[0, 0.5, 1].map((f) => svg('g', null, svg('line', { x1: pad.l, x2: W - pad.r, y1: y(top * f), y2: y(top * f), class: 'ov-grid' }), svg('text', { x: pad.l - 6, y: y(top * f) + 4, 'text-anchor': 'end', class: 'ov-axis' }, fmt(Math.round(top * f))))),
    ];
    if (!vals.some((v) => v > 0)) g.push(svg('text', { x: (pad.l + W - pad.r) / 2, y: top0 + LANE / 2, 'text-anchor': 'middle', class: 'ov-axis' }, 'No data in this period'));
    for (const se of drawn) {
      let d = '';
      slots.forEach((s, k) => {
        if (s[se.key] == null) return;
        d += `${d && slots[k - 1]?.[se.key] != null ? 'L' : 'M'}${cx(k).toFixed(1)} ${y(s[se.key]).toFixed(1)}`;
      });
      g.push(svg('path', { d, class: 'ov-trend-line', stroke: se.color, 'stroke-dasharray': se.dash ? '5 4' : null }));
      if (n <= 12) slots.forEach((s, k) => s[se.key] != null && g.push(svg('circle', { cx: cx(k), cy: y(s[se.key]), r: 3.5, fill: se.color, class: 'ov-dot' })));
    }
    return g;
  });

  const cross = svg('line', { y1: pad.t - 4, y2: plotBottom, class: 'ov-cross', visibility: 'hidden' });
  const chart = svg(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'ov-line', role: 'img', tabindex: 0, 'aria-label': `${lanes.map((l) => l.title).join(', ')} per period. Use the arrow keys to read each period.` },
    slots.map((s, k) => (k % every === 0 || k === n - 1) && svg('text', { x: cx(k), y: H - 6, 'text-anchor': 'middle', class: 'ov-axis' }, s.label)),
    cross,
    parts.flat(),
    svg('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: plotBottom, fill: 'transparent' }),
  );
  const tip = h('div', { class: 'ov-tip', hidden: true });
  const wrap = h('div', { class: 'ov-chart' }, chart, tip);

  let at = -1;
  const show = (k) => {
    at = Math.max(0, Math.min(n - 1, k));
    const s = slots[at];
    cross.setAttribute('x1', cx(at));
    cross.setAttribute('x2', cx(at));
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 'ov-tip-head' }, s.label, s.partial ? ' (so far)' : ''),
      ...lanes.flatMap((lane) => lane.series.map((se) => h('div', { class: 'ov-tip-row' }, h('i', { style: se.hidden ? 'background:transparent' : `background:${se.color}` }), h('b', null, s[se.key] == null ? '—' : (se.fmt || lane.fmt || String)(s[se.key])), h('span', null, se.tip || se.label)))),
    );
    tip.hidden = false;
    // Beside the crosshair, on whichever side has room, so it never covers the period being read.
    const x = (cx(at) / W) * wrap.clientWidth;
    const right = x < wrap.clientWidth / 2;
    tip.style.left = right ? `${x + 12}px` : '';
    tip.style.right = right ? '' : `${wrap.clientWidth - x + 12}px`;
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  chart.addEventListener('pointermove', (e) => {
    const r = chart.getBoundingClientRect();
    show(Math.floor(((e.clientX - r.left) * (W / r.width) - pad.l) / band));
  });
  chart.addEventListener('pointerleave', hide);
  chart.addEventListener('blur', hide);
  chart.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    show(at < 0 ? n - 1 : at + (e.key === 'ArrowRight' ? 1 : -1));
  });
  return wrap;
}

function sparkline(slots, key, color) {
  const W = 120;
  const H = 30;
  const pts = slots.map((s, k) => [k, s[key]]).filter(([, v]) => v != null);
  if (pts.length < 2) return null;
  const max = Math.max(1, ...pts.map(([, v]) => v));
  const x = (k) => 2 + (k / (slots.length - 1)) * (W - 4);
  const y = (v) => 3 + (1 - v / max) * (H - 6);
  const [lk, lv] = pts[pts.length - 1];
  return svg(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, class: 'ov-spark', 'aria-hidden': 'true' },
    svg('polyline', { points: pts.map(([k, v]) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }),
    svg('circle', { cx: x(lk), cy: y(lv), r: 2.5, fill: color }),
  );
}

// A metric as a tab: latest value, change against the average before it (coloured by whether that is good), sparkline.
function metricTile(m, sum, slots, { selected, onSelect }) {
  const fmt = m.fmt || String;
  let delta = null;
  if (sum?.delta) {
    const good = (sum.delta > 0) === (m.better === 'up');
    delta = h('span', { class: `ov-delta ${good ? 'good' : 'bad'}`, title: `Average before: ${fmt(sum.avg)}` }, h('span', { 'aria-hidden': 'true' }, sum.delta > 0 ? '▲ ' : '▼ '), `${m.max === 100 ? `${Math.abs(sum.delta)} pts` : fmt(Math.abs(sum.delta))} vs avg`);
  } else if (sum && sum.delta === 0) delta = h('span', { class: 'ov-delta' }, 'same as avg');
  return h(
    'button',
    { class: 'ov-card ov-metric', role: 'tab', 'aria-selected': String(selected), onClick: onSelect },
    h('span', { class: 'ov-stat-label' }, m.label),
    h('span', { class: 'ov-metric-row' }, h('b', { class: 'ov-stat-value' }, sum ? fmt(sum.value) : '—'), sparkline(slots, m.key, 'var(--chart-1)')),
    h('span', { class: 'muted small' }, sum ? `${m.current ? 'now' : sum.label}` : 'no data yet', delta && ' · ', delta),
  );
}

const TREND_COLS = [
  ['Period', (s) => s.label + (s.partial ? ' (so far)' : '')],
  ['New', (s) => s.created],
  ['Done', (s) => s.done],
  ['Tasks done', (s) => s.tasksDone],
  ['SP done', (s) => s.spDone],
  ['Bugs reported', (s) => s.bugsNew],
  ['Bugs fixed', (s) => s.bugsDone],
  ['Open at end', (s) => s.backlog],
  ['Lead time, median', (s) => (s.leadMedian == null ? '—' : `${s.leadMedian}d`)],
  ['Lead time, 85%', (s) => (s.leadP85 == null ? '—' : `${s.leadP85}d`)],
  ['On time', (s) => (s.onTime == null ? '—' : `${s.onTime}%`)],
  ['Bugs of done', (s) => (s.bugShare == null ? '—' : `${s.bugShare}%`)],
];

function trendTable(slots) {
  return h(
    'details',
    { class: 'ov-table' },
    h('summary', { class: 'muted small' }, 'Show the numbers as a table'),
    h('div', { class: 'ov-table-scroll' }, h('table', null, h('thead', null, h('tr', null, TREND_COLS.map(([t]) => h('th', null, t)))), h('tbody', null, slots.map((s) => h('tr', null, TREND_COLS.map(([, f]) => h('td', null, f(s)))))))),
  );
}

const TIP_LABEL = { bad: 'Fix', warn: 'Watch', good: 'Good' };
const TIP_ICON = { bad: '!', warn: '▲', good: '✓' };

function insightsCard(tips) {
  const body = tips.length
    ? h(
        'ul',
        { class: 'ov-tips' },
        tips.map((t) =>
          h(
            'li',
            { class: `ov-tip-item ${t.level}` },
            h('span', { class: 'ov-tip-badge' }, h('span', { 'aria-hidden': 'true' }, TIP_ICON[t.level]), TIP_LABEL[t.level]),
            h('div', null, h('b', null, t.title), h('p', { class: 'muted small' }, t.detail), t.action && h('p', { class: 'ov-tip-action small' }, '→ ', t.action)),
          ),
        ),
      )
    : emptyChart('Not enough history yet to suggest anything.');
  return card('How to improve', 'from the trends above and today’s open work', body, { cls: 'ov-insights' });
}
