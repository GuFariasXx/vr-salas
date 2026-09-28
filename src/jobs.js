const cron = require('node-cron');
const config = require('./config');
const { query } = require('./db');
const { getSettings } = require('./services/settings');
const { notify } = require('./services/notify');
const { esc } = require('./services/mail');
const google = require('./services/google');

const TZ = config.tz;
const fmt = (b) => `${b.local_date.split('-').reverse().join('/')} das ${b.local_start} às ${b.local_end}`;

const SELECT_EXTRA = `
  to_char(b.starts_at AT TIME ZONE '${TZ}','YYYY-MM-DD') AS local_date,
  to_char(b.starts_at AT TIME ZONE '${TZ}','HH24:MI') AS local_start,
  to_char(b.ends_at   AT TIME ZONE '${TZ}','HH24:MI') AS local_end`;

/** Lembrete de check-in ao organizador. */
async function sendReminders(s) {
  const { rows } = await query(
    `UPDATE bookings b SET reminder_sent_at=now()
       FROM rooms r
      WHERE r.id=b.room_id AND r.requires_checkin AND b.status='confirmed' AND b.reminder_sent_at IS NULL
        AND b.starts_at > now() AND b.starts_at <= now() + make_interval(mins => $1)
      RETURNING b.*, r.name AS room_name, ${SELECT_EXTRA}`, [s.reminder_before_min]);
  for (const b of rows) {
    const { rows: u } = await query('SELECT id,name,email FROM users WHERE id=$1', [b.user_id]);
    await notify(u[0], {
      type: 'checkin_reminder',
      title: 'Lembrete de check-in',
      message: `Sua reunião "${b.title}" na sala ${b.room_name} começa às ${b.local_start}. Faça o check-in em até ${s.checkin_tolerance_min} min após o início ou a sala será liberada.`,
      bookingId: b.id,
      cta: { label: 'Fazer check-in', url: `${config.appUrl}/app#/minhas` },
    });
  }
}

/** Marca no-show, libera a sala e notifica organizador e chefe. */
async function processNoShows(s) {
  const { rows } = await query(
    `UPDATE bookings b SET status='no_show'
       FROM rooms r
      WHERE r.id=b.room_id AND r.requires_checkin AND b.status='confirmed'
        AND now() > b.starts_at + make_interval(mins => $1)
      RETURNING b.*, r.name AS room_name, r.location AS room_location, ${SELECT_EXTRA}`, [s.checkin_tolerance_min]);

  for (const b of rows) {
    const { rows: [user] } = await query(
      `UPDATE users SET noshow_count = noshow_count + 1 WHERE id=$1
       RETURNING id,name,email,department,manager_id`, [b.user_id]);
    const { rows: [manager] } = user.manager_id
      ? await query('SELECT id,name,email FROM users WHERE id=$1 AND active', [user.manager_id])
      : { rows: [] };

    await notify(user, {
      type: 'no_show',
      title: 'Reserva sem check-in',
      message: `Não identificamos check-in na reunião "${b.title}" (${b.room_name}, ${fmt(b)}). A sala foi liberada${manager ? ' e seu gestor foi notificado' : ''}.`,
      bookingId: b.id,
    });

    if (manager) {
      await notify(manager, {
        type: 'team_no_show',
        title: `${user.name} não fez check-in`,
        message: `${user.name}${user.department ? ' (' + user.department + ')' : ''} não realizou check-in na reserva "${b.title}" — sala ${b.room_name}, ${fmt(b)}. A sala foi liberada automaticamente.`,
        emailHtml: `
          <p><b>${esc(user.name)}</b>${user.department ? ' (' + esc(user.department) + ')' : ''}, que está vinculado(a) a você como gestor, não realizou o check-in de uma reserva de sala.</p>
          <table cellpadding="6" style="border-collapse:collapse;font-size:14px;margin:12px 0">
            <tr><td style="color:#71717a">Reunião</td><td><b>${esc(b.title)}</b></td></tr>
            <tr><td style="color:#71717a">Sala</td><td>${esc(b.room_name)}${b.room_location ? ' · ' + esc(b.room_location) : ''}</td></tr>
            <tr><td style="color:#71717a">Horário</td><td>${fmt(b)}</td></tr>
            <tr><td style="color:#71717a">Tolerância</td><td>${s.checkin_tolerance_min} minutos</td></tr>
          </table>
          <p>A sala foi liberada automaticamente para outras reservas.</p>`,
        bookingId: b.id,
        cta: { label: 'Ver relatório de no-show', url: `${config.appUrl}/app#/relatorios` },
      });
    }

    await google.patchEventEnd(b, null,
      `A sala ${b.room_name} foi liberada automaticamente por falta de check-in (VR Salas).`);
    console.log(`[job] no-show reserva #${b.id} (${user.email})${manager ? ' → gestor ' + manager.email : ''}`);
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const s = await getSettings();
    await sendReminders(s);
    await processNoShows(s);
  } catch (e) {
    console.error('[job]', e.message);
  } finally {
    running = false;
  }
}

function startJobs() {
  cron.schedule('* * * * *', tick, { timezone: TZ });
  setTimeout(tick, 3000);
  console.log('[job] Monitor de check-in ativo (a cada minuto)');
}

module.exports = { startJobs, tick };
