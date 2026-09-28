const { google } = require('googleapis');
const config = require('../config');
const { query } = require('../db');

const enabled = () => Boolean(config.google.clientId && config.google.clientSecret);

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
];

function oauthClient(baseUrl = config.appUrl) {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    `${baseUrl}/api/auth/google/callback`
  );
}

function authUrl(state, baseUrl) {
  const params = {
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  };
  if (config.google.allowedDomain) params.hd = config.google.allowedDomain;
  return oauthClient(baseUrl).generateAuthUrl(params);
}

async function exchangeCode(code, baseUrl) {
  const client = oauthClient(baseUrl);
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
  return { tokens, profile: ticket.getPayload() };
}

async function calendarFor(userId) {
  if (!enabled()) return null;
  const { rows } = await query('SELECT google_refresh_token FROM users WHERE id=$1', [userId]);
  const rt = rows[0] && rows[0].google_refresh_token;
  if (!rt) return null;
  const client = oauthClient();
  client.setCredentials({ refresh_token: rt });
  return google.calendar({ version: 'v3', auth: client });
}

function eventBody(b, room) {
  const attendees = [...new Set((b.participants || []).filter(Boolean))].map((email) => ({ email }));
  if (room.google_resource_email) attendees.push({ email: room.google_resource_email, resource: true });
  return {
    summary: b.title,
    location: [room.name, room.location].filter(Boolean).join(' · '),
    description: `${b.description || ''}\n\nReserva VR Salas #${b.id} — faça o check-in em ${config.appUrl}/app#/minhas`.trim(),
    start: { dateTime: new Date(b.starts_at).toISOString(), timeZone: config.tz },
    end: { dateTime: new Date(b.ends_at).toISOString(), timeZone: config.tz },
    attendees,
    reminders: { useDefault: true },
    extendedProperties: { private: { vrSalasBookingId: String(b.id) } },
  };
}

/** Cria ou atualiza o evento do organizador. Falhas não bloqueiam a reserva. */
async function upsertEvent(booking, room) {
  try {
    const cal = await calendarFor(booking.user_id);
    if (!cal) return null;
    const requestBody = eventBody(booking, room);
    let res;
    if (booking.google_event_id) {
      res = await cal.events.update({ calendarId: 'primary', eventId: booking.google_event_id, requestBody, sendUpdates: 'all' });
    } else {
      res = await cal.events.insert({ calendarId: 'primary', requestBody, sendUpdates: 'all' });
    }
    await query('UPDATE bookings SET google_event_id=$1 WHERE id=$2', [res.data.id, booking.id]);
    return res.data.id;
  } catch (e) {
    console.error('[google] upsertEvent:', e.message);
    return null;
  }
}

async function deleteEvent(booking) {
  if (!booking.google_event_id) return;
  try {
    const cal = await calendarFor(booking.user_id);
    if (!cal) return;
    await cal.events.delete({ calendarId: 'primary', eventId: booking.google_event_id, sendUpdates: 'all' });
  } catch (e) {
    console.error('[google] deleteEvent:', e.message);
  }
}

/** Ajusta o fim do evento (usado quando a sala é liberada por no-show). */
async function patchEventEnd(booking, endsAt, note) {
  if (!booking.google_event_id) return;
  try {
    const cal = await calendarFor(booking.user_id);
    if (!cal) return;
    await cal.events.patch({
      calendarId: 'primary',
      eventId: booking.google_event_id,
      requestBody: { summary: `[Sala liberada] ${booking.title}`, description: note },
      sendUpdates: 'none',
    });
  } catch (e) {
    console.error('[google] patchEvent:', e.message);
  }
}

module.exports = { enabled, authUrl, exchangeCode, upsertEvent, deleteEvent, patchEventEnd };
