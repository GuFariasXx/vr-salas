const { query } = require('../db');

const DEFAULTS = {
  checkin_open_before_min: 10,
  checkin_tolerance_min: 15,
  max_duration_min: 240,
  max_advance_days: 60,
  reminder_before_min: 15,
};

function parse(key, v) {
  const d = DEFAULTS[key];
  if (typeof d === 'boolean') return v === 'true';
  if (typeof d === 'number') return Number(v);
  return v;
}

async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const out = { ...DEFAULTS };
  rows.forEach((r) => { if (r.key in DEFAULTS) out[r.key] = parse(r.key, r.value); });
  return out;
}

async function saveSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULTS)) continue;
    await query(
      'INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
      [k, String(v)]
    );
  }
  return getSettings();
}

module.exports = { getSettings, saveSettings, DEFAULTS };
