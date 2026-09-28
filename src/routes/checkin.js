// Check-in por QR Code: cada sala tem um token impresso num QR colado na porta.
const router = require('express').Router();
const config = require('../config');
const { query } = require('../db');
const { h, HttpError } = require('../middleware');
const { getSettings } = require('../services/settings');
const { audit } = require('../services/audit');

const TZ = config.tz;

async function roomByToken(token) {
  if (!/^[a-f0-9]{16,40}$/.test(String(token || ''))) throw new HttpError(404, 'QR code inválido');
  const { rows } = await query('SELECT id,name,location,color,requires_checkin FROM rooms WHERE checkin_token=$1 AND active', [token]);
  if (!rows[0]) throw new HttpError(404, 'QR code inválido ou sala desativada. Peça um QR atualizado ao administrador.');
  return rows[0];
}

/** Reservas de hoje nesta sala em que o usuário é organizador ou convidado. */
async function bookingsFor(room, user, s) {
  const { rows } = await query(
    `SELECT b.id, b.title, b.status, b.starts_at, b.ends_at, b.user_id, u.name AS user_name,
            to_char(b.starts_at AT TIME ZONE $3,'HH24:MI') AS local_start,
            to_char(b.ends_at   AT TIME ZONE $3,'HH24:MI') AS local_end,
            to_char((b.starts_at - make_interval(mins => $4)) AT TIME ZONE $3,'HH24:MI') AS opens_at,
            (now() >= b.starts_at - make_interval(mins => $4) AND now() <= b.starts_at + make_interval(mins => $5)) AS in_window
       FROM bookings b JOIN users u ON u.id=b.user_id
      WHERE b.room_id=$1 AND b.status IN ('confirmed','checked_in')
        AND (b.user_id=$2 OR $6 = ANY(b.participants) OR $7)
        AND (b.starts_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date
        AND b.ends_at > now()
      ORDER BY b.starts_at`,
    [room.id, user.id, TZ, s.checkin_open_before_min, s.checkin_tolerance_min, user.email, user.role === 'admin']);
  return rows;
}

router.get('/:token', h(async (req, res) => {
  const room = await roomByToken(req.params.token);
  const s = await getSettings();
  res.json({ room, bookings: await bookingsFor(room, req.user, s), settings: { open_before: s.checkin_open_before_min, tolerance: s.checkin_tolerance_min } });
}));

router.post('/:token', h(async (req, res) => {
  const room = await roomByToken(req.params.token);
  const s = await getSettings();
  const list = await bookingsFor(room, req.user, s);
  const wanted = req.body.booking_id ? list.find((b) => b.id === Number(req.body.booking_id)) : list.find((b) => b.in_window || b.status === 'checked_in');
  if (!wanted) {
    const next = list.find((b) => b.status === 'confirmed');
    if (next) throw new HttpError(400, `O check-in de "${next.title}" abre às ${next.opens_at}.`);
    throw new HttpError(404, `Você não tem reunião agora na ${room.name}.`);
  }
  if (wanted.status === 'checked_in') return res.json({ ok: true, already: true, booking: wanted, room });
  if (!wanted.in_window) throw new HttpError(400, `Fora do horário de check-in (abre às ${wanted.opens_at}, tolerância de ${s.checkin_tolerance_min} min).`);
  const { rowCount } = await query(
    "UPDATE bookings SET status='checked_in', checkin_at=now(), checkin_by=$1, checkin_method='qr' WHERE id=$2 AND status='confirmed'",
    [req.user.id, wanted.id]);
  if (rowCount) await audit(req.user.id, 'checkin', 'booking', wanted.id, { method: 'qr', room: room.name });
  res.json({ ok: true, booking: { ...wanted, status: 'checked_in' }, room });
}));

module.exports = router;
