const jwt = require('jsonwebtoken');
const config = require('./config');
const { query } = require('./db');

const COOKIE = 'vrsalas_token';

/** Cria a sessão e derruba as anteriores do mesmo usuário (incrementa session_version). */
async function issueSession(res, user) {
  const { rows } = await query('UPDATE users SET session_version = session_version + 1 WHERE id=$1 RETURNING session_version', [user.id]);
  const token = jwt.sign({ uid: user.id, sv: rows[0].session_version }, config.jwtSecret, { expiresIn: '12h' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https'),
    maxAge: 12 * 3600 * 1000,
  });
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const { uid, sv } = jwt.verify(token, config.jwtSecret);
    const { rows } = await query(
      'SELECT id,name,email,role,department,manager_id,active,checkin_mode,session_version,(google_refresh_token IS NOT NULL) AS google_linked FROM users WHERE id=$1',
      [uid]
    );
    const user = rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'Sessão inválida' });
    if (sv !== user.session_version) {
      res.clearCookie(COOKIE);
      return res.status(401).json({ error: 'Sua sessão foi encerrada porque sua conta entrou em outro dispositivo ou navegador.', code: 'replaced' });
    }
    delete user.session_version;
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Sessão expirada' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores' });
  next();
}

/** Encapsula handlers async e converte erros em respostas JSON. */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

module.exports = { COOKIE, issueSession, requireAuth, requireAdmin, h, HttpError };
