'use strict';

// 3D office demo (the static build from scripts/office-demo.js): made-up people and tasks shaped like
// /api/team-sprint, and a tick that moves one task along now and then so the scenes between rooms play.
// Loaded before app.js only in that build; office-scene.html never loads it.

const OFFICE_DEMO = (() => {
  const day = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  const ago = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  let n = 500;
  const T = (summary, status, extra = {}) => {
    const category = status === 'To Do' ? 'new' : status === 'Done' ? 'done' : 'indeterminate';
    return { key: `DEMO-${++n}`, summary, type: 'Task', status: { name: status, category }, priority: 'Medium', due: day(5), updated: ago(1), storyPoints: 3, ...extra };
  };
  const data = {
    sprint: { id: 1, name: 'Demo Sprint 12', state: 'active', startDate: day(-8), endDate: day(6) },
    members: [
      { accountId: 'me', name: 'Demo User', me: true, role: 'dev', tasks: [T('Grade essay answers', 'In Progress'), T('Fix student list paging', 'In Review', { type: 'Bug' }), T('Weekly timetable', 'Done')] },
      { accountId: 'd1', name: 'Minh Anh', role: 'dev', tasks: [T('Course detail page', 'In Progress', { storyPoints: 5 }), T('Course level filter', 'Done')] },
      { accountId: 'd2', name: 'Quoc Bao', role: 'dev', tasks: [T('Attendance sync', 'In Progress', { due: day(-2), storyPoints: 8 }), T('New homework notification', 'To Do')] },
      { accountId: 'q1', name: 'Thu Ha', role: 'qa', tasks: [T('Test progress report export', 'In Testing'), T('Test math rendering', 'Done')] },
      { accountId: 'd3', name: 'Duc Huy', role: 'dev', tasks: [T('Tuition charged twice', 'In Progress', { priority: 'Highest', type: 'Bug' }), T('Payment API tests', 'To Do')] },
      { accountId: 'd4', name: 'Ngoc Lan', role: 'dev', tasks: [T('Timed quiz', 'Done', { storyPoints: 8 }), T('Completion certificate PDF', 'Done')] },
      { accountId: 'd5', name: 'Hoang Nam', role: 'dev', tasks: [T('Profile page translations', 'To Do'), T('Parent dashboard', 'To Do', { storyPoints: 8 })] },
      { accountId: 'q2', name: 'Khanh Linh', role: 'qa', tasks: [T('Test multi-part video upload', 'In Progress'), T('Thumbnail test cases', 'To Do')] },
      { accountId: 'd6', name: 'Gia Phuc', role: 'dev', tasks: [T('Teacher SSO sign-in', 'In Progress', { updated: ago(5), storyPoints: 8 })] },
      { accountId: 'd7', name: 'Thanh Tam', role: 'dev', tasks: [T('Submission history', 'Selftest'), T('Document download timeout', 'Done', { type: 'Bug' })] },
      { accountId: 'q3', name: 'Bao Tram', role: 'qa', tasks: [T('Class management test', 'Done'), T('Exam time zone check', 'In Progress')] },
      { accountId: 'd8', name: 'Tuan Kiet', role: 'dev', tasks: [T('Course suggestions', 'To Do'), T('Student FAQ page', 'To Do')] },
    ],
  };
  const NEXT = { 'To Do': 'In Progress', 'In Progress': 'In Review', Selftest: 'In Review', 'In Review': 'Done', 'In Testing': 'Done' };
  const NEW = ['Avatar upload fails', 'Filter by teacher', 'Attendance stats page', 'Deadline reminder email', 'Video will not play on Safari'];
  // One step of a believable sprint: mostly a task moves on (now and then back from review), sometimes a new one lands.
  function tick() {
    const people = data.members.filter((m) => !m.me);
    const p = people[Math.floor(Math.random() * people.length)];
    const open = p.tasks.filter((t) => t.status.category !== 'done');
    if (Math.random() < 0.2 || !open.length) {
      const bug = Math.random() < 0.5;
      p.tasks.push(T(NEW[Math.floor(Math.random() * NEW.length)], 'To Do', bug ? { type: 'Bug', priority: Math.random() < 0.3 ? 'Highest' : 'Medium' } : {}));
    } else {
      const t = open[Math.floor(Math.random() * open.length)];
      const back = t.status.name === 'In Review' && Math.random() < 0.25;
      const name = back ? 'In Progress' : NEXT[t.status.name] || 'Done';
      t.status = { name, category: name === 'Done' ? 'done' : 'indeterminate' };
      t.updated = new Date().toISOString();
    }
    return JSON.parse(JSON.stringify(data));
  }
  return { data: () => JSON.parse(JSON.stringify(data)), tick };
})();
