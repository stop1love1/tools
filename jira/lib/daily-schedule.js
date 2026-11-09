'use strict';

// When the daily report reminder fires (electron-main.js). No dependencies, so the Electron main process can load it
// without the server's modules.

const LATE_MS = 6 * 60 * 60 * 1000; // still fire when the app starts up to this long after the time

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// cfg: Settings → Daily report ({ enabled, time: 'HH:MM', days: [Date#getDay numbers] }); last: dayKey of the day
// it last fired.
function dailyDue(cfg, now, last) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(cfg?.time || '');
  if (!cfg?.enabled || !m) return false;
  if (!Array.isArray(cfg.days) || !cfg.days.includes(now.getDay())) return false;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]));
  return now >= at && now - at <= LATE_MS && last !== dayKey(now);
}

module.exports = { dailyDue, dayKey, LATE_MS };
