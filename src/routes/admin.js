const router = require('express').Router();
const config = require('../config');
const { query } = require('../db');
const { requireAdmin, h, HttpError } = require('../middleware');
const { getSettings, saveSettings } = require('../services/settings');
const { audit } = require('../services/audit');

const TZ = config.tz;

router.get('/settings', h(async (req, res) => res.json(await getSettings())));

router.put('/settings', requireAdmin, h(async (req, res) => {
  const b = req.body;
  for (const k of ['checkin_open_before_min', 'checkin_tolerance_min', 'max_duration_min', 'max_advance_days', 'reminder_before_min']) {
    if (b[k] !== undefined && (!Number.isFinite(Number(b[k])) || Number(b[k]) < 0)) throw new HttpError(400, `Valor inválido: ${k}`);
  }
  const s = await saveSettings(b);
  await audit(req.user.id, 'update', 'settings', null, b);
  res.json(s);
}));

// Indicadores do painel
router.get('/stats', h(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);
  const { rows: [k] } = await query(
    `SELECT
       count(*) FILTER (WHERE (starts_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date AND status IN ('confirmed','checked_in')) AS today,
       count(*) FILTER (WHERE status IN ('confirmed','checked_in') AND now() BETWEEN starts_at AND ends_at) AS ongoing,
       count(*) FILTER (WHERE starts_at > now() - make_interval(days => $2) AND starts_at < now() AND status IN ('checked_in','no_show')) AS verified,
       count(*) FILTER (WHERE starts_at > now() - make_interval(days => $2) AND status='no_show') AS noshows,
       count(*) FILTER (WHERE starts_at > now() - make_interval(days => $2) AND status='cancelled') AS cancelled
     FROM bookings`, [TZ, days]);
  const { rows: byRoom } = await query(
    `SELECT r.name, r.color, count(b.id)::int AS bookings,
            coalesce(round(sum(extract(epoch FROM b.ends_at - b.starts_at))/3600.0, 1), 0)::float AS hours
       FROM rooms r LEFT JOIN bookings b ON b.room_id=r.id AND b.status IN ('confirmed','checked_in')
            AND b.starts_at > now() - make_interval(days => $1)
      WHERE r.active GROUP BY r.id ORDER BY hours DESC`, [days]);
  res.json({
    days,
    today: Number(k.today), ongoing: Number(k.ongoing),
    noshows: Number(k.noshows), cancelled: Number(k.cancelled),
    noshowRate: Number(k.verified) ? Math.round((Number(k.noshows) / Number(k.verified)) * 100) : 0,
    byRoom,
  });
}));

// Relatório de no-show (admin)
router.get('/reports/noshow', requireAdmin, h(async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.department, m.name AS manager_name,
            count(*) FILTER (WHERE b.status='no_show')::int AS noshows,
            count(*) FILTER (WHERE b.status='checked_in')::int AS checkins,
            max(b.starts_at) FILTER (WHERE b.status='no_show') AS last_noshow
       FROM bookings b JOIN users u ON u.id=b.user_id LEFT JOIN users m ON m.id=u.manager_id
      WHERE b.starts_at > now() - make_interval(days => $1) AND b.starts_at < now()
      GROUP BY u.id, m.name HAVING count(*) FILTER (WHERE b.status='no_show') > 0
      ORDER BY noshows DESC`, [days]);
  res.json(rows);
}));

router.get('/audit', requireAdmin, h(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      ORDER BY a.created_at DESC LIMIT 200`);
  res.json(rows);
}));

module.exports = router;
