const { query } = require('../db');
const { sendMail } = require('./mail');

/** Cria notificação no sistema e (opcionalmente) envia e-mail. */
async function notify(user, { type, title, message, bookingId, email = true, emailHtml, cta }) {
  if (!user) return;
  await query(
    'INSERT INTO notifications (user_id,type,title,message,booking_id) VALUES ($1,$2,$3,$4,$5)',
    [user.id, type, title, message, bookingId || null]
  );
  if (email && user.email) {
    await sendMail({ to: user.email, subject: `VR Salas · ${title}`, title, html: emailHtml || message, cta });
  }
}

module.exports = { notify };
