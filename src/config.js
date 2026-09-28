require('dotenv').config();

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'sim'].includes(String(v).toLowerCase()));

module.exports = {
  port: Number(process.env.PORT || 3000),
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  databaseUrl: process.env.DATABASE_URL,
  admin: {
    name: process.env.ADMIN_NAME || 'Administrador',
    email: (process.env.ADMIN_EMAIL || 'admin@vrsoft.com.br').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || 'Admin@123',
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: bool(process.env.SMTP_SECURE, true),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || 'VR Salas <no-reply@vrsoft.com.br>',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    allowedDomain: (process.env.GOOGLE_ALLOWED_DOMAIN || '').toLowerCase(),
    autoProvision: bool(process.env.GOOGLE_AUTO_PROVISION, true),
  },
  tz: process.env.TZ || 'America/Sao_Paulo',
};
