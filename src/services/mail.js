const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;
if (config.smtp.host && config.smtp.user) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(title, bodyHtml, cta) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Roboto,Arial,sans-serif;color:#27272a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden">
    <tr><td style="background:linear-gradient(135deg,#FF6A00,#C93400);background-color:#E8620E;padding:20px 28px;color:#fff;font-size:18px;font-weight:700;letter-spacing:.5px">VR SALAS</td></tr>
    <tr><td style="padding:28px">
      <h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>
      <div style="font-size:14px;line-height:1.6">${bodyHtml}</div>
      ${cta ? `<p style="margin-top:24px"><a href="${cta.url}" style="background:#E8620E;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>` : ''}
    </td></tr>
    <tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:12px;color:#71717a">VR Software · Simplifique</td></tr>
  </table></td></tr></table></body></html>`;
}

async function sendMail({ to, subject, title, html, cta }) {
  if (!to || (Array.isArray(to) && !to.length)) return;
  const message = { from: config.smtp.from, to, subject, html: layout(title || subject, html, cta) };
  if (!transporter) {
    console.log(`[mail] (SMTP não configurado) Para: ${to} | Assunto: ${subject}`);
    return;
  }
  try {
    await transporter.sendMail(message);
  } catch (e) {
    console.error('[mail] Falha ao enviar:', e.message);
  }
}

module.exports = { sendMail, esc };
