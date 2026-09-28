const router = require('express').Router();
const crypto = require('crypto');
const config = require('../config');
const { query } = require('../db');
const { h, HttpError } = require('../middleware');
const { getSettings } = require('../services/settings');
const { audit } = require('../services/audit');
const { notify } = require('../services/notify');
const { sendMail, esc } = require('../services/mail');
const google = require('../services/google');

const TZ = config.tz;
const ACTIVE = "('confirmed','checked_in')";

const BASE_SELECT = `
  SELECT b.*, r.name AS room_name, r.location AS room_location, r.color AS room_color,
         r.requires_checkin, u.name AS user_name, u.email AS user_email,
         to_char(b.starts_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS local_date,
         to_char(b.starts_at AT TIME ZONE '${TZ}', 'HH24:MI') AS local_start,
         to_char(b.ends_at   AT TIME ZONE '${TZ}', 'HH24:MI') AS local_end
    FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN users u ON u.id=b.user_id`;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = (s) => /^\d{2}:\d{2}$/.test(s || '');

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (dateStr) => new Date(dateStr + 'T12:00:00Z').getUTCDay();

function canManage(user, b) {
  return user.role === 'admin' || user.id === b.user_id;
}

async function loadBooking(id) {
  const { rows } = await query(`${BASE_SELECT} WHERE b.id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Reserva não encontrada');
  return rows[0];
}

function parseParticipants(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[,;\s]+/);
  const emails = arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) throw new HttpError(400, `E-mail de participante inválido: ${bad}`);
  return [...new Set(emails)];
}

/** Valida regras de negócio de uma ocorrência (data local + hora início/fim). */
async function validateSlot(room, date, start, end, settings) {
  if (!isDate(date) || !isTime(start) || !isTime(end)) throw new HttpError(400, 'Data ou horário inválido');
  if (start >= end) throw new HttpError(400, 'O horário final deve ser maior que o inicial');
  const open = room.open_time.slice(0, 5), close = room.close_time.slice(0, 5);
  if (start < open || end > close) throw new HttpError(400, `A sala ${room.name} funciona das ${open} às ${close}`);
  const [sh, sm] = start.split(':').map(Number), [eh, em] = end.split(':').map(Number);
  const minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes > settings.max_duration_min) throw new HttpError(400, `Duração máxima por reserva: ${settings.max_duration_min} minutos`);

  const { rows } = await query(
    `SELECT ($1::date + $2::time) AT TIME ZONE $4 AS s, ($1::date + $3::time) AT TIME ZONE $4 AS e,
            (($1::date + $2::time) AT TIME ZONE $4) < now() AS past,
            $1::date > (now() AT TIME ZONE $4)::date + $5::int AS too_far`,
    [date, start, end, TZ, settings.max_advance_days]
  );
  if (rows[0].past) throw new HttpError(400, 'Não é possível reservar um horário que já passou');
  if (rows[0].too_far) throw new HttpError(400, `Reservas permitidas com até ${settings.max_advance_days} dias de antecedência`);
  return { startsAt: rows[0].s, endsAt: rows[0].e };
}

async function getRoom(id) {
  const { rows } = await query('SELECT * FROM rooms WHERE id=$1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Sala não encontrada');
  if (!rows[0].active) throw new HttpError(400, 'Sala inativa');
  return rows[0];
}

async function conflictOf(roomId, startsAt, endsAt, ignoreId) {
  const { rows } = await query(
    `SELECT b.title, u.name AS user_name,
            to_char(b.starts_at AT TIME ZONE $4,'HH24:MI') AS s, to_char(b.ends_at AT TIME ZONE $4,'HH24:MI') AS e
       FROM bookings b JOIN users u ON u.id=b.user_id
      WHERE b.room_id=$1 AND b.status IN ${ACTIVE}
        AND tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange($2,$3,'[)') AND b.id <> COALESCE($5,0)
      LIMIT 1`, [roomId, startsAt, endsAt, TZ, ignoreId || null]);
  return rows[0];
}

// ---------- Consultas ----------

// Agenda de um dia (ou intervalo) — visível para todos
router.get('/', h(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : null;
  const to = isDate(req.query.to) ? req.query.to : from;
  if (!from) throw new HttpError(400, 'Informe a data (from=YYYY-MM-DD)');
  const params = [from, to, TZ];
  let where = `b.status IN ('confirmed','checked_in','no_show')
     AND b.starts_at >= ($1::date)::timestamp AT TIME ZONE $3
     AND b.starts_at <  ($2::date + 1)::timestamp AT TIME ZONE $3`;
  if (req.query.room_id) { params.push(Number(req.query.room_id)); where += ` AND b.room_id=$${params.length}`; }
  const { rows } = await query(`${BASE_SELECT} WHERE ${where} ORDER BY b.starts_at`, params);
  res.json(rows);
}));

// scope: upcoming (padrão) | past | all (próximas primeiro, depois as passadas)
router.get('/mine', h(async (req, res) => {
  const mine = '(b.user_id=$1 OR $2 = ANY(b.participants))';
  const p = [req.user.id, req.user.email];
  const upcoming = () => query(`${BASE_SELECT} WHERE ${mine} AND b.ends_at >= now() AND b.status IN ('confirmed','checked_in') ORDER BY b.starts_at ASC`, p);
  const past = () => query(`${BASE_SELECT} WHERE ${mine} AND b.ends_at < now() ORDER BY b.starts_at DESC LIMIT 100`, p);
  const scope = req.query.scope;
  if (scope === 'past') return res.json((await past()).rows);
  if (scope === 'all') {
    const [u, pa] = await Promise.all([upcoming(), past()]);
    return res.json([...u.rows, ...pa.rows]);
  }
  res.json((await upcoming()).rows);
}));

// Salas livres num período, com filtros
router.get('/availability', h(async (req, res) => {
  const { date, start, end } = req.query;
  if (!isDate(date) || !isTime(start) || !isTime(end) || start >= end) throw new HttpError(400, 'Período inválido');
  const capacity = Number(req.query.capacity || 1);
  const resource = req.query.resource || null;
  const { rows } = await query(
    `SELECT r.*, NOT EXISTS (
         SELECT 1 FROM bookings b WHERE b.room_id=r.id AND b.status IN ${ACTIVE}
           AND tstzrange(b.starts_at,b.ends_at,'[)') &&
               tstzrange(($1::date + $2::time) AT TIME ZONE $4, ($1::date + $3::time) AT TIME ZONE $4,'[)')
       ) AS free,
       ($2::time >= r.open_time AND $3::time <= r.close_time) AS within_hours
     FROM rooms r
     WHERE r.active AND r.capacity >= $5 AND ($6::text IS NULL OR $6 = ANY(r.resources))
     ORDER BY r.capacity, r.name`,
    [date, start, end, TZ, capacity, resource]
  );
  rows.forEach((r) => delete r.checkin_token);
  res.json(rows);
}));

router.get('/:id', h(async (req, res) => res.json(await loadBooking(Number(req.params.id)))));

// ---------- Criação ----------

router.post('/', h(async (req, res) => {
  const settings = await getSettings();
  const room = await getRoom(Number(req.body.room_id));
  const title = String(req.body.title || '').trim();
  if (!title) throw new HttpError(400, 'Informe o assunto da reunião');
  const participants = parseParticipants(req.body.participants);
  if (participants.length + 1 > room.capacity) {
    // Apenas aviso — muitos convidados podem ser remotos
    res.set('X-Capacity-Warning', '1');
  }

  // Admin pode reservar em nome de outro usuário
  let ownerId = req.user.id;
  if (req.body.user_id && req.user.role === 'admin') ownerId = Number(req.body.user_id);

  const freq = ['daily', 'weekly'].includes(req.body.repeat) ? req.body.repeat : 'none';
  const count = freq === 'none' ? 1 : Math.min(Math.max(Number(req.body.repeat_count) || 1, 1), 26);
  if (!isDate(req.body.date)) throw new HttpError(400, 'Data inválida');
  const dates = [];
  let d = req.body.date;
  while (dates.length < count) {
    if (freq !== 'daily' || (weekday(d) !== 0 && weekday(d) !== 6)) dates.push(d); // diário ignora fim de semana
    d = addDays(d, freq === 'weekly' ? 7 : 1);
  }

  const seriesId = count > 1 ? crypto.randomUUID() : null;
  const created = [], skipped = [];
  for (const date of dates) {
    let slot;
    try {
      slot = await validateSlot(room, date, req.body.start, req.body.end, settings);
    } catch (e) {
      if (dates.length === 1) throw e;
      skipped.push({ date, reason: e.message });
      continue;
    }
    try {
      const { rows } = await query(
        `INSERT INTO bookings (room_id,user_id,title,description,starts_at,ends_at,participants,series_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [room.id, ownerId, title, req.body.description || null, slot.startsAt, slot.endsAt, participants, seriesId]
      );
      created.push(rows[0]);
    } catch (e) {
      if (e.code !== '23P01') throw e;
      const c = await conflictOf(room.id, slot.startsAt, slot.endsAt);
      const reason = c ? `Sala ocupada das ${c.s} às ${c.e} (${c.title} — ${c.user_name})` : 'Horário indisponível';
      if (dates.length === 1) throw new HttpError(409, reason);
      skipped.push({ date, reason });
    }
  }
  if (!created.length) throw new HttpError(409, 'Nenhuma ocorrência pôde ser reservada: ' + skipped.map((s) => `${s.date} (${s.reason})`).join('; '));

  // Google Agenda (não bloqueante)
  for (const b of created) await google.upsertEvent(b, room);

  // Sem Google vinculado: avisa participantes por e-mail
  const { rows: ow } = await query('SELECT id,name,email,google_refresh_token IS NOT NULL AS g FROM users WHERE id=$1', [ownerId]);
  if (!ow[0].g && participants.length) {
    const first = await loadBooking(created[0].id);
    await sendMail({
      to: participants,
      subject: `Convite: ${title}`,
      title: `Convite: ${title}`,
      html: `<b>${esc(ow[0].name)}</b> reservou a sala <b>${esc(room.name)}</b> para
        ${first.local_date.split('-').reverse().join('/')} das ${first.local_start} às ${first.local_end}
        ${created.length > 1 ? ` (${created.length} ocorrências)` : ''}.<br>${esc(req.body.description || '')}`,
    });
  }
  if (ownerId !== req.user.id) {
    await notify(ow[0], { type: 'booking_created', title: 'Reserva criada para você',
      message: `${req.user.name} reservou ${room.name} em seu nome: ${title}.`, bookingId: created[0].id });
  }

  await audit(req.user.id, 'create', 'booking', created[0].id, { room: room.name, count: created.length, skipped: skipped.length });
  res.status(201).json({ created: created.map((b) => b.id), skipped, capacityWarning: participants.length + 1 > room.capacity });
}));

// ---------- Edição ----------

router.put('/:id', h(async (req, res) => {
  const b = await loadBooking(Number(req.params.id));
  if (!canManage(req.user, b)) throw new HttpError(403, 'Apenas o organizador ou um administrador pode alterar');
  if (b.status !== 'confirmed') throw new HttpError(400, 'Só é possível alterar reservas confirmadas que ainda não começaram');
  const settings = await getSettings();
  const room = await getRoom(Number(req.body.room_id || b.room_id));
  const slot = await validateSlot(room, req.body.date, req.body.start, req.body.end, settings);
  const participants = parseParticipants(req.body.participants ?? b.participants);
  try {
    const { rows } = await query(
      `UPDATE bookings SET room_id=$1,title=$2,description=$3,starts_at=$4,ends_at=$5,participants=$6,reminder_sent_at=NULL
        WHERE id=$7 RETURNING *`,
      [room.id, String(req.body.title || b.title).trim(), req.body.description ?? b.description, slot.startsAt, slot.endsAt, participants, b.id]
    );
    await google.upsertEvent(rows[0], room);
  } catch (e) {
    if (e.code !== '23P01') throw e;
    const c = await conflictOf(room.id, slot.startsAt, slot.endsAt, b.id);
    throw new HttpError(409, c ? `Sala ocupada das ${c.s} às ${c.e} (${c.title} — ${c.user_name})` : 'Horário indisponível');
  }
  await audit(req.user.id, 'update', 'booking', b.id);
  res.json({ ok: true });
}));

// ---------- Cancelamento ----------

router.post('/:id/cancel', h(async (req, res) => {
  const b = await loadBooking(Number(req.params.id));
  if (!canManage(req.user, b)) throw new HttpError(403, 'Apenas o organizador ou um administrador pode cancelar');
  if (!['confirmed', 'checked_in'].includes(b.status)) throw new HttpError(400, 'Reserva já encerrada ou cancelada');
  const reason = String(req.body.reason || '').slice(0, 200) || null;

  const { rows: targets } = req.body.scope === 'series' && b.series_id
    ? await query("SELECT * FROM bookings WHERE series_id=$1 AND status='confirmed' AND starts_at >= $2", [b.series_id, b.starts_at])
    : { rows: [b] };

  for (const t of targets) {
    await query("UPDATE bookings SET status='cancelled', cancelled_at=now(), cancel_reason=$1 WHERE id=$2", [reason, t.id]);
    await google.deleteEvent(t);
  }
  if (req.user.id !== b.user_id) {
    const { rows } = await query('SELECT id,name,email FROM users WHERE id=$1', [b.user_id]);
    await notify(rows[0], { type: 'booking_cancelled', title: 'Reserva cancelada',
      message: `Sua reserva "${b.title}" na sala ${b.room_name} (${b.local_date.split('-').reverse().join('/')} ${b.local_start}) foi cancelada por ${req.user.name}.${reason ? ' Motivo: ' + reason : ''}`,
      bookingId: b.id });
  }
  await audit(req.user.id, 'cancel', 'booking', b.id, { count: targets.length, reason });
  res.json({ ok: true, cancelled: targets.length });
}));

// ---------- Check-in / encerramento ----------

router.post('/:id/checkin', h(async (req, res) => {
  const b = await loadBooking(Number(req.params.id));
  const allowed = req.user.role === 'admin' || req.user.id === b.user_id || (b.participants || []).includes(req.user.email);
  if (!allowed) throw new HttpError(403, 'Somente o organizador ou participantes podem fazer check-in');
  if (b.status === 'checked_in') return res.json({ ok: true, already: true });
  if (b.status !== 'confirmed') throw new HttpError(400, 'Esta reserva não aceita mais check-in');
  const s = await getSettings();
  if (req.user.checkin_mode === 'qr' && !(req.user.role === 'admin' && b.user_id !== req.user.id)) throw new HttpError(400, 'Seu check-in é feito pelo QR code da sala. Use "Check-in QR" e aponte a câmera para o QR da porta.');
  const { rows } = await query(
    `SELECT now() >= $1::timestamptz - make_interval(mins => $2) AS opened,
            now() <= $1::timestamptz + make_interval(mins => $3) AS in_time`,
    [b.starts_at, s.checkin_open_before_min, s.checkin_tolerance_min]
  );
  if (!rows[0].opened) throw new HttpError(400, `O check-in abre ${s.checkin_open_before_min} min antes do início`);
  if (!rows[0].in_time) throw new HttpError(400, 'Prazo de check-in encerrado');
  await query("UPDATE bookings SET status='checked_in', checkin_at=now(), checkin_by=$1, checkin_method='button' WHERE id=$2 AND status='confirmed'", [req.user.id, b.id]);
  await audit(req.user.id, 'checkin', 'booking', b.id);
  res.json({ ok: true });
}));

// Encerrar antes e liberar a sala
router.post('/:id/finish', h(async (req, res) => {
  const b = await loadBooking(Number(req.params.id));
  if (!canManage(req.user, b) && !(b.participants || []).includes(req.user.email)) throw new HttpError(403, 'Sem permissão');
  const { rows } = await query(
    `UPDATE bookings SET ends_at=greatest(now(), starts_at + interval '1 minute')
      WHERE id=$1 AND status IN ${ACTIVE} AND now() >= starts_at AND now() < ends_at RETURNING *`, [b.id]);
  if (!rows[0]) throw new HttpError(400, 'A reunião não está em andamento');
  const { rows: r } = await query('SELECT * FROM rooms WHERE id=$1', [b.room_id]);
  await google.upsertEvent(rows[0], r[0]);
  await audit(req.user.id, 'finish', 'booking', b.id);
  res.json({ ok: true });
}));

module.exports = router;
