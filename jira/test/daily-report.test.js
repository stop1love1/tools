'use strict';

// Daily report: the text format the team uses in Teams, which tasks go where, the expected hand-over date,
// when the reminder fires, and the Settings validation of its fields.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { mkTemp, rmTemp } = require('./_helpers');
const { dailyDue, dayKey } = require('../lib/daily-schedule');

let tmp;
test.before(() => {
  tmp = mkTemp();
});
test.after(() => rmTemp(tmp));

function loadWith(searchAll) {
  const libDir = path.resolve(__dirname, '..', 'lib') + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(libDir)) delete require.cache[k];
  require.cache[require.resolve('../lib/mcp')] = { exports: { searchAll, callTool: async () => ({}), userInfo: async () => ({}) } };
  return require('../lib/daily-report');
}

const st = (name, category = 'indeterminate') => ({ name, statusCategory: { key: category } });
const TODAY = new Date(2026, 10, 9, 10, 0).toISOString();
const LAST_WEEK = new Date(2026, 10, 2, 10, 0).toISOString();
const issue = (key, status, duedate = null, updated = TODAY, issuetype = { name: 'Story', subtask: false }, parent = null) => ({
  key,
  fields: { summary: `Summary ${key}`, status, duedate, updated, issuetype, parent },
});
const SUBTASK = { name: 'Subtask', subtask: true };

// Monday 09/11/2026, 17:05 local time.
const MON = new Date(2026, 10, 9, 17, 5);

test('format: nothing handed over, matches the message sent in Teams', () => {
  const { formatReport } = loadWith(async () => []);
  const text = formatReport({
    now: MON,
    handedOver: [],
    pending: [
      { key: 'VLEARN-5800', status: 'Ready for SIT', expected: new Date(2026, 10, 10) },
      { key: 'VLEARN-5799', status: 'In review', expected: new Date(2026, 10, 10) },
      { key: 'VLEARN-5797', status: 'In progress', expected: new Date(2026, 10, 10) },
    ],
  });
  assert.equal(
    text,
    ['Ngày 09/11/2026', '- Đã bàn giao: 0', '- Đã làm nhưng chưa bàn giao:', '', '• VLEARN-5800 (Ready for SIT - 10/11)', '• VLEARN-5799 (In review - 10/11)', '• VLEARN-5797 (In progress - 10/11)'].join('\n'),
  );
});

test('format: handed-over list and an empty pending list', () => {
  const { formatReport } = loadWith(async () => []);
  const text = formatReport({ now: MON, handedOver: [{ key: 'VLEARN-1', status: 'Ready for UAT' }], pending: [] });
  assert.equal(text, ['Ngày 09/11/2026', '- Đã bàn giao:', '', '• VLEARN-1 (Ready for UAT)', '', '- Đã làm nhưng chưa bàn giao: 0'].join('\n'));
});

test('expected date: due date when today or later, else the next working day', () => {
  const { expectedDate, nextWorkingDay } = loadWith(async () => []);
  assert.equal(dayKey(expectedDate('2026-11-12', MON)), '2026-11-12');
  assert.equal(dayKey(expectedDate('2026-11-09', MON)), '2026-11-09'); // due today stays today
  assert.equal(dayKey(expectedDate('2026-11-01', MON)), '2026-11-10'); // overdue → tomorrow
  assert.equal(dayKey(expectedDate(null, MON)), '2026-11-10');
  assert.equal(dayKey(expectedDate('garbage', MON)), '2026-11-10');
  // Friday → Monday, Saturday → Monday.
  assert.equal(dayKey(nextWorkingDay(new Date(2026, 10, 13))), '2026-11-16');
  assert.equal(dayKey(nextWorkingDay(new Date(2026, 10, 14))), '2026-11-16');
});

test('build: sorts tasks into handed over / pending by the workflow settings', async () => {
  const calls = [];
  const { buildDailyReport } = loadWith(async (jql, fields) => {
    calls.push({ jql, fields });
    if (/status CHANGED BY currentUser\(\) AFTER startOfDay\(\)/.test(jql)) {
      return [
        issue('VLEARN-10', st('Ready for UAT')), // a tester has it → handed over
        issue('VLEARN-11', st('Test SIT Done', 'new')), // tested → handed over
        issue('VLEARN-12', st('Done', 'done')), // done → handed over
        issue('VLEARN-13', st('Ready for SIT')), // waiting for a tester → not handed over
        issue('VLEARN-14', st('In Progress')), // still coding
      ];
    }
    return [
      issue('VLEARN-10', st('Ready for UAT')), // already counted as handed over
      issue('VLEARN-13', st('Ready for SIT'), '2026-11-12'),
      issue('VLEARN-14', st('In Progress')),
      issue('VLEARN-15', st('In Review')),
      issue('VLEARN-16', st('In Testing')), // a tester has it, not changed today: in neither list
      issue('VLEARN-17', st('READY FOR SIT'), null, LAST_WEEK), // parked in Ready for SIT for a week: left out
      issue('VLEARN-18', st('In Review'), null, LAST_WEEK), // in review, untouched today: left out
      issue('VLEARN-19', st('In Progress'), null, LAST_WEEK), // still coding, untouched today: listed
    ];
  });
  const r = await buildDailyReport(MON);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => /assignee = currentUser\(\)/.test(c.jql)));
  assert.ok(calls.every((c) => c.fields.includes('updated')));
  assert.deepEqual(r.handedOver.map((t) => t.key), ['VLEARN-10', 'VLEARN-11', 'VLEARN-12']);
  assert.deepEqual(r.pending.map((t) => [t.key, t.expected]), [
    ['VLEARN-13', '2026-11-12'],
    ['VLEARN-14', '2026-11-10'],
    ['VLEARN-15', '2026-11-10'],
    ['VLEARN-19', '2026-11-10'],
  ]);
  assert.equal(r.date, '2026-11-09');
  assert.equal(r.site, 'https://vin3s.atlassian.net'); // the dialog links ticket keys to <site>/browse/<key>
  assert.match(
    r.text,
    /^Ngày 09\/11\/2026\n- Đã bàn giao:\n\n• VLEARN-10: Summary VLEARN-10 \(Ready for UAT\)\n• VLEARN-11: Summary VLEARN-11 \(Test SIT Done\)\n• VLEARN-12: Summary VLEARN-12 \(Done\)\n\n- Đã làm nhưng chưa bàn giao:\n\n• VLEARN-13: Summary VLEARN-13 \(Ready for SIT - 12\/11\)\n/,
  );
});

test('format: "KEY: title (status - date) cc @tester", title trimmed, key alone when there is no title', () => {
  const { formatReport } = loadWith(async () => []);
  const text = formatReport({
    now: MON,
    handedOver: [{ key: 'VLEARN-4914', summary: '  [Admin] Đưa entrypoint Xuất hồ sơ lớp học vào màn Xuất báo cáo ', status: 'Done', testers: [] }],
    pending: [
      { key: 'VLEARN-5800', summary: '[BE] Hợp nhất user_rewards thành user_certificates', status: 'READY FOR SIT', expected: new Date(2026, 10, 10), testers: ['Nguyễn Thị Phượng'] },
      { key: 'VLEARN-9', summary: '', status: 'In Progress', expected: new Date(2026, 10, 10) },
    ],
  });
  assert.equal(
    text,
    [
      'Ngày 09/11/2026', '- Đã bàn giao:', '',
      '• VLEARN-4914: [Admin] Đưa entrypoint Xuất hồ sơ lớp học vào màn Xuất báo cáo (Done)', '',
      '- Đã làm nhưng chưa bàn giao:', '',
      '• VLEARN-5800: [BE] Hợp nhất user_rewards thành user_certificates (READY FOR SIT - 10/11) cc @Nguyễn Thị Phượng',
      '• VLEARN-9 (In Progress - 10/11)',
    ].join('\n'),
  );
});

test('build: only stories and bugs — subtasks and tasks left out; a story counts as touched when its subtask was', async () => {
  const { buildDailyReport } = loadWith(async (jql) => {
    if (/CHANGED BY currentUser/.test(jql)) {
      return [
        issue('VLEARN-4914', st('Done', 'done')), // story I closed today → handed over
        issue('VLEARN-5845', st('Done', 'done'), null, TODAY, SUBTASK, { key: 'VLEARN-5800' }), // subtask closed → left out
        issue('VLEARN-30', st('Ready for UAT'), null, TODAY, { name: 'Task', subtask: false }), // task → left out
        issue('VLEARN-31', st('Ready for UAT'), null, TODAY, { name: 'bug', subtask: false }), // bug (any case) → handed over
      ];
    }
    return [
      issue('VLEARN-5800', st('READY FOR SIT'), null, LAST_WEEK), // its subtask 5845 was done today → touched
      issue('VLEARN-5799', st('In Review'), null, LAST_WEEK), // its subtask 5853 is in review today → touched
      issue('VLEARN-5853', st('In Review'), null, TODAY, SUBTASK, { key: 'VLEARN-5799' }),
      issue('VLEARN-5797', st('In Progress')),
      issue('VLEARN-5868', st('In Progress'), null, TODAY, SUBTASK, { key: 'VLEARN-5797' }),
      issue('VLEARN-2386', st('READY FOR SIT'), null, TODAY, { name: 'Bug', subtask: false }),
      issue('VLEARN-40', st('In Progress'), null, TODAY, { name: 'Task', subtask: false }), // task → left out
      issue('VLEARN-41', st('READY FOR SIT'), null, LAST_WEEK), // no subtask touched today → left out
    ];
  });
  const r = await buildDailyReport(MON);
  assert.deepEqual(r.handedOver.map((t) => t.key), ['VLEARN-4914', 'VLEARN-31']);
  assert.deepEqual(r.pending.map((t) => t.key), ['VLEARN-5800', 'VLEARN-5799', 'VLEARN-5797', 'VLEARN-2386']);
});

test('build: ticket types come from Settings', async () => {
  const { buildDailyReport } = loadWith(async (jql) =>
    /CHANGED BY/.test(jql) ? [] : [issue('VLEARN-1', st('In Progress')), issue('VLEARN-2', st('In Progress'), null, TODAY, { name: 'Task', subtask: false })],
  );
  const config = require('../lib/config');
  config.save({ 'daily.issueTypes': ['Task'] });
  try {
    assert.deepEqual((await buildDailyReport(MON)).pending.map((t) => t.key), ['VLEARN-2']);
  } finally {
    config.save({ 'daily.issueTypes': ['Story', 'Bug'] });
  }
});

test('build: no tasks at all', async () => {
  const { buildDailyReport } = loadWith(async () => []);
  const r = await buildDailyReport(MON);
  assert.equal(r.text, 'Ngày 09/11/2026\n- Đã bàn giao: 0\n- Đã làm nhưng chưa bàn giao: 0');
});

test('build: a Jira error reaches the caller (the dialog shows it)', async () => {
  const { buildDailyReport } = loadWith(async () => {
    throw new Error('Atlassian MCP timed out');
  });
  await assert.rejects(buildDailyReport(MON), /timed out/);
});

test('schedule: fires at the time, once a day, within the late window', () => {
  const cfg = { enabled: true, time: '17:00', days: [1, 2, 3, 4, 5] };
  const at = (h, m, day = 9) => new Date(2026, 10, day, h, m);
  assert.equal(dailyDue(cfg, at(16, 59), ''), false);
  assert.equal(dailyDue(cfg, at(17, 0), ''), true);
  assert.equal(dailyDue(cfg, at(17, 0), '2026-11-09'), false); // already fired today
  assert.equal(dailyDue(cfg, at(17, 0), '2026-11-06'), true); // fired last Friday
  assert.equal(dailyDue(cfg, at(22, 59), ''), true); // app started late
  assert.equal(dailyDue(cfg, at(23, 1), ''), false); // too late
});

test('schedule: off switch, weekends and bad times', () => {
  const at = (day) => new Date(2026, 10, day, 17, 30);
  assert.equal(dailyDue({ enabled: false, time: '17:00', days: [1, 2, 3, 4, 5] }, at(9), ''), false);
  assert.equal(dailyDue({ enabled: true, time: '17:00', days: [1, 2, 3, 4, 5] }, at(14), ''), false); // Saturday
  assert.equal(dailyDue({ enabled: true, time: '17:00', days: [1, 2, 3, 4, 5] }, at(15), ''), false); // Sunday
  assert.equal(dailyDue({ enabled: true, time: '17:00', days: [0, 1, 2, 3, 4, 5, 6] }, at(14), ''), true);
  assert.equal(dailyDue({ enabled: true, time: '25:00', days: [0, 1, 2, 3, 4, 5, 6] }, at(9), ''), false);
  assert.equal(dailyDue({ enabled: true, time: '', days: [0, 1, 2, 3, 4, 5, 6] }, at(9), ''), false);
  assert.equal(dailyDue(undefined, at(9), ''), false);
  assert.equal(dailyDue({ enabled: true, time: '08:30', days: [1, 2, 3, 4, 5] }, new Date(2026, 10, 9, 8, 30), ''), true);
  // Any set of days: Tuesday and Thursday only.
  const tueThu = { enabled: true, time: '17:00', days: [2, 4] };
  assert.equal(dailyDue(tueThu, at(9), ''), false); // Monday
  assert.equal(dailyDue(tueThu, at(10), ''), true); // Tuesday
  assert.equal(dailyDue(tueThu, at(12), ''), true); // Thursday
  assert.equal(dailyDue({ enabled: true, time: '17:00', days: [6] }, at(14), ''), true); // Saturday only
  assert.equal(dailyDue({ enabled: true, time: '17:00', days: [] }, at(9), ''), false);
  assert.equal(dailyDue({ enabled: true, time: '17:00' }, at(9), ''), false); // no days at all
});

test('settings: defaults, validation, and the browser gets them', () => {
  const libDir = path.resolve(__dirname, '..', 'lib') + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(libDir)) delete require.cache[k];
  const config = require('../lib/config');
  assert.deepEqual(config.client().daily, { enabled: true, time: '17:00', days: [1, 2, 3, 4, 5], issueTypes: ['Story', 'Bug'], testerField: 'customfield_16481', teamsUrl: 'https://teams.live.com/v2/' });
  assert.throws(() => config.save({ 'daily.time': '5pm' }), /Reminder time/);
  assert.throws(() => config.save({ 'daily.time': '7:00' }), /Reminder time/);
  assert.throws(() => config.save({ 'daily.time': '24:00' }), /Reminder time/);
  assert.throws(() => config.save({ 'daily.enabled': 'yes' }), /Remind me/);
  assert.throws(() => config.save({ 'daily.days': [] }), /Remind on/);
  assert.throws(() => config.save({ 'daily.days': [7] }), /Remind on/);
  assert.throws(() => config.save({ 'daily.days': [1, 1] }), /Remind on/);
  assert.throws(() => config.save({ 'daily.days': ['1'] }), /Remind on/);
  config.save({ 'daily.days': [0, 6] });
  assert.deepEqual(config.client().daily.days, [0, 6]);
  config.save({ 'daily.days': [1, 2, 3, 4, 5] });
  assert.throws(() => config.save({ 'daily.teamsUrl': 'teams' }), /Teams link/);
  config.save({ 'daily.enabled': false, 'daily.time': '16:45' });
  assert.equal(config.client().daily.enabled, false);
  assert.equal(config.client().daily.time, '16:45');
  const saved = JSON.parse(fs.readFileSync(process.env.DASHBOARD_CONFIG_FILE, 'utf8'));
  assert.deepEqual(saved.daily, { enabled: false, time: '16:45' }); // defaults are not written
  config.save({ 'daily.enabled': true, 'daily.time': '17:00' });
  assert.equal(JSON.parse(fs.readFileSync(process.env.DASHBOARD_CONFIG_FILE, 'utf8')).daily, undefined);
});

test('tester cc: names from the Tester field, without the "- username" suffix', () => {
  const { testersOf, formatReport } = loadWith(async () => []);
  const F = 'customfield_16481';
  assert.deepEqual(testersOf({ [F]: [{ displayName: 'Nguyễn Thị Phượng - phuongnt425' }] }, F), ['Nguyễn Thị Phượng']);
  assert.deepEqual(testersOf({ [F]: { displayName: 'Vũ Vui' } }, F), ['Vũ Vui']); // single user picker
  assert.deepEqual(testersOf({ [F]: [{ displayName: 'A - a1' }, { displayName: 'B' }] }, F), ['A', 'B']);
  assert.deepEqual(testersOf({ [F]: null }, F), []);
  assert.deepEqual(testersOf({ [F]: [{ displayName: 'X' }] }, ''), []); // field turned off in Settings
  const text = formatReport({
    now: MON,
    handedOver: [{ key: 'VLEARN-1', status: 'Ready for UAT', testers: ['Nguyễn Thị Phượng'] }],
    pending: [
      { key: 'VLEARN-5800', status: 'READY FOR SIT', expected: new Date(2026, 10, 10), testers: ['Nguyễn Thị Phượng', 'Vũ Vui'] },
      { key: 'VLEARN-5797', status: 'In Progress', expected: new Date(2026, 10, 10), testers: [] },
    ],
  });
  assert.equal(
    text,
    [
      'Ngày 09/11/2026', '- Đã bàn giao:', '', '• VLEARN-1 (Ready for UAT) cc @Nguyễn Thị Phượng', '',
      '- Đã làm nhưng chưa bàn giao:', '', '• VLEARN-5800 (READY FOR SIT - 10/11) cc @Nguyễn Thị Phượng @Vũ Vui', '• VLEARN-5797 (In Progress - 10/11)',
    ].join('\n'),
  );
});

test('tester cc: the build asks Jira for the Tester field and fills it in', async () => {
  const seen = [];
  const { buildDailyReport } = loadWith(async (jql, fields) => {
    seen.push(fields);
    return /CHANGED BY/.test(jql) ? [] : [{ key: 'VLEARN-5', fields: { status: st('In Progress'), issuetype: { name: 'Story' }, updated: TODAY, customfield_16481: [{ displayName: 'Nguyễn Thị Phượng - phuongnt425' }] } }];
  });
  const r = await buildDailyReport(MON);
  assert.ok(seen.every((f) => f.includes('customfield_16481')));
  assert.deepEqual(r.pending[0].testers, ['Nguyễn Thị Phượng']);
  assert.match(r.text, /VLEARN-5 \(In Progress - 10\/11\) cc @Nguyễn Thị Phượng$/);
});

test('user filter: both searches run for the person the header shows', async () => {
  const jqls = [];
  const { buildDailyReport } = loadWith(async (jql) => (jqls.push(jql), []));
  await buildDailyReport(MON, (jql) => jql.replace(/currentUser\(\)/g, '"acc-123"'));
  assert.equal(jqls.length, 2);
  assert.ok(jqls.every((j) => !/currentUser\(\)/.test(j) && /assignee = "acc-123"/.test(j)));
  assert.match(jqls[0], /status CHANGED BY "acc-123" AFTER startOfDay\(\)/);
});
