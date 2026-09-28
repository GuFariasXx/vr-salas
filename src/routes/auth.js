const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query } = require('../db');
const { issueSession, requireAuth, COOKIE, h, HttpError } = require('../middleware');
const google = require('../services/google');
const { sendMail } = require('../services/mail');
const { audit } = require('../services/audit');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });


router.post('/login', loginLimiter, h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) throw new HttpError(400, 'Informe e-mail e senha');
  const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(password, u.password_hash))) {
    throw new HttpError(401, 'E-mail ou senha inválidos');
  }
  if (!u.active) throw new HttpError(403, 'Usuário inativo. Procure um administrador.');
  await issueSession(res, u);
  await audit(u.id, 'login', 'user', u.id, { method: 'password' });
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json(req.user));

router.post('/change-password', requireAuth, h(async (req, res) => {
  const { current, next } = req.body;
  if (!next || next.length < 8) throw new HttpError(400, 'A nova senha deve ter ao menos 8 caracteres');
  const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (rows[0].password_hash && !(await bcrypt.compare(String(current || ''), rows[0].password_hash))) {
    throw new HttpError(400, 'Senha atual incorreta');
  }
  await query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [await bcrypt.hash(next, 10), req.user.id]);
  await issueSession(res, req.user); // mantém esta sessão e encerra as demais
  res.json({ ok: true });
}));

// ---- Esqueci minha senha ----
router.post('/forgot', loginLimiter, h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await query('SELECT id,name,email FROM users WHERE email=$1 AND active', [email]);
  if (rows[0]) {
    const token = crypto.randomBytes(32).toString('hex');
    await query("INSERT INTO password_resets(token,user_id,expires_at) VALUES($1,$2, now() + interval '1 hour')", [token, rows[0].id]);
    await sendMail({
      to: rows[0].email,
      subject: 'VR Salas · Redefinição de senha',
      title: 'Redefinição de senha',
      html: `Olá, ${rows[0].name}. Recebemos um pedido para redefinir sua senha. O link é válido por 1 hora.`,
      cta: { label: 'Definir nova senha', url: `${config.appUrl}/?reset=${token}` },
    });
  }
  // Resposta sempre igual para não expor e-mails cadastrados
  res.json({ ok: true });
}));

router.post('/reset', h(async (req, res) => {
  const { token, password } = req.body;
  if (!password || password.length < 8) throw new HttpError(400, 'A senha deve ter ao menos 8 caracteres');
  const { rows } = await query('SELECT * FROM password_resets WHERE token=$1 AND used_at IS NULL AND expires_at > now()', [token]);
  if (!rows[0]) throw new HttpError(400, 'Link inválido ou expirado');
  await query('UPDATE users SET password_hash=$1, session_version=session_version+1, updated_at=now() WHERE id=$2', [await bcrypt.hash(password, 10), rows[0].user_id]);
  await query('UPDATE password_resets SET used_at=now() WHERE token=$1', [token]);
  res.json({ ok: true });
}));

// ---- Google OAuth ----
// O Google só aceita retorno em localhost ou domínio com HTTPS. Se o sistema estiver
// configurado por IP (APP_URL=http://192.168...), quem acessar por localhost
// ainda consegue vincular o Google usando o retorno em localhost.
function googleBase(req) {
  if (['localhost', '127.0.0.1'].includes(req.hostname)) return `http://localhost:${req.get('host').split(':')[1] || 80}`;
  return config.appUrl;
}
const isIpUrl = (u) => /^https?:\/\/\d{1,3}(\.\d{1,3}){3}(:|\/|$)/.test(u);

router.get('/config', (req, res) => {
  const configured = google.enabled();
  const ipBlocked = configured && isIpUrl(googleBase(req));
  res.json({ googleEnabled: configured && !ipBlocked, googleConfigured: configured, ipBlocked, domain: config.google.allowedDomain });
});

router.get('/google', (req, res) => {
  if (!google.enabled()) return res.redirect('/?error=' + encodeURIComponent('Login Google não configurado'));
  const base = googleBase(req);
  if (isIpUrl(base)) {
    return res.redirect('/?error=' + encodeURIComponent('O Google não aceita acesso por IP. Para vincular, abra o sistema por http://localhost:3000 na máquina do servidor ou use o domínio da empresa.'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('g_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  // Já logado => "Vincular": associa a conta Google ao usuário da sessão, sem trocar de usuário
  const nextUrl = String(req.query.next || '');
  if (/^\/(app|checkin)([?#/].*)?$/.test(nextUrl)) res.cookie('g_next', nextUrl, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  else res.clearCookie('g_next');
  const uid = sessionUserId(req);
  if (uid) res.cookie('g_link', jwt.sign({ uid, state }, config.jwtSecret, { expiresIn: '10m' }), { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  else res.clearCookie('g_link');
  res.redirect(google.authUrl(state, base));
});

function sessionUserId(req) {
  try { return jwt.verify(req.cookies[COOKIE], config.jwtSecret).uid; } catch { return null; }
}

router.get('/google/callback', h(async (req, res) => {
  const fail = (msg) => res.redirect('/?error=' + encodeURIComponent(msg));
  if (!req.query.code || req.query.state !== req.cookies.g_state) return fail('Falha na autenticação Google');
  res.clearCookie('g_state');

  const { tokens, profile } = await google.exchangeCode(req.query.code, googleBase(req));
  const email = String(profile.email || '').toLowerCase();
  const domain = config.google.allowedDomain;
  if (!profile.email_verified) return fail('E-mail Google não verificado');
  if (domain && profile.hd !== domain && !email.endsWith('@' + domain)) return fail(`Use uma conta @${domain}`);

  // Modo vincular: mantém o usuário logado e só guarda a autorização da agenda
  let link = null;
  try { link = jwt.verify(req.cookies.g_link || '', config.jwtSecret); } catch {}
  res.clearCookie('g_link');
  if (link && link.state === req.query.state && link.uid === sessionUserId(req)) {
    await query('UPDATE users SET google_sub=$1, google_refresh_token=COALESCE($2, google_refresh_token), updated_at=now() WHERE id=$3',
      [profile.sub, tokens.refresh_token || null, link.uid]);
    await audit(link.uid, 'google_link', 'user', link.uid, { google_email: email });
    return res.redirect('/app#/inicio');
  }

  let { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
  let u = rows[0];
  if (!u) {
    if (!config.google.autoProvision) return fail('Usuário não cadastrado. Procure um administrador.');
    ({ rows } = await query(
      "INSERT INTO users (name,email,role,google_sub) VALUES ($1,$2,'user',$3) RETURNING *",
      [profile.name || email, email, profile.sub]
    ));
    u = rows[0];
    await audit(u.id, 'create', 'user', u.id, { via: 'google' });
  }
  if (!u.active) return fail('Usuário inativo. Procure um administrador.');

  await query(
    'UPDATE users SET google_sub=$1, google_refresh_token=COALESCE($2, google_refresh_token), updated_at=now() WHERE id=$3',
    [profile.sub, tokens.refresh_token || null, u.id]
  );
  await issueSession(res, u);
  await audit(u.id, 'login', 'user', u.id, { method: 'google' });
  const nextUrl = /^\/(app|checkin)([?#/].*)?$/.test(req.cookies.g_next || '') ? req.cookies.g_next : '/app';
  res.clearCookie('g_next');
  res.redirect(nextUrl);
}));

router.post('/google/unlink', requireAuth, h(async (req, res) => {
  await query('UPDATE users SET google_refresh_token=NULL WHERE id=$1', [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
