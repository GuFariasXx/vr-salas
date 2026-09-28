const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, tx } = require('../db');
const { requireAdmin, h, HttpError } = require('../middleware');
const { audit } = require('../services/audit');
const google = require('../services/google');

const FIELDS = `u.id,u.name,u.email,u.role,u.department,u.manager_id,u.active,u.noshow_count,u.created_at,u.checkin_mode,
  (u.google_refresh_token IS NOT NULL) AS google_linked, m.name AS manager_name, m.email AS manager_email`;

// Diretório simples (todos os usuários autenticados) — usado para convidar participantes
router.get('/directory', h(async (req, res) => {
  const { rows } = await query('SELECT id,name,email,department FROM users WHERE active ORDER BY name');
  res.json(rows);
}));

router.get('/', requireAdmin, h(async (req, res) => {
  const { rows } = await query(`SELECT ${FIELDS} FROM users u LEFT JOIN users m ON m.id=u.manager_id ORDER BY u.name`);
  res.json(rows);
}));

function validate(body, isNew) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (!name) throw new HttpError(400, 'Nome é obrigatório');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'E-mail inválido');
  if (!['admin', 'user'].includes(body.role || 'user')) throw new HttpError(400, 'Perfil inválido');
  if (isNew && body.password && body.password.length < 8) throw new HttpError(400, 'Senha deve ter ao menos 8 caracteres');
  return { name, email, role: body.role || 'user', department: body.department || null,
    manager_id: body.manager_id ? Number(body.manager_id) : null, active: body.active !== false,
    checkin_mode: body.checkin_mode === 'qr' ? 'qr' : 'both' };
}

async function assertNoManagerCycle(userId, managerId) {
  if (!managerId) return;
  if (userId && managerId === userId) throw new HttpError(400, 'O usuário não pode ser o próprio chefe');
  if (!userId) return;
  // Sobe a cadeia do chefe informado; se encontrar o próprio usuário há ciclo
  const { rows } = await query(`WITH RECURSIVE chain AS (
      SELECT id, manager_id FROM users WHERE id=$1
      UNION SELECT u.id, u.manager_id FROM users u JOIN chain c ON u.id=c.manager_id)
    SELECT 1 FROM chain WHERE id=$2`, [managerId, userId]);
  if (rows.length) throw new HttpError(400, 'Hierarquia inválida: isso criaria um ciclo de chefia');
}

router.post('/', requireAdmin, h(async (req, res) => {
  const d = validate(req.body, true);
  const hash = req.body.password ? await bcrypt.hash(req.body.password, 10) : null;
  try {
    const { rows } = await query(
      `INSERT INTO users (name,email,password_hash,role,department,manager_id,active,checkin_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [d.name, d.email, hash, d.role, d.department, d.manager_id, d.active, d.checkin_mode]
    );
    await audit(req.user.id, 'create', 'user', rows[0].id, { email: d.email, role: d.role });
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Já existe um usuário com este e-mail');
    throw e;
  }
}));

// Alteração em lote: aplica só os campos enviados em "changes" a todos os ids
router.put('/batch', requireAdmin, h(async (req, res) => {
  const ids = [...new Set((req.body.ids || []).map(Number).filter(Number.isInteger))];
  const c = req.body.changes || {};
  if (!ids.length) throw new HttpError(400, 'Selecione ao menos um usuário');
  const sets = [], params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };

  if ('role' in c) {
    if (!['admin', 'user'].includes(c.role)) throw new HttpError(400, 'Perfil inválido');
    if (c.role !== 'admin' && ids.includes(req.user.id)) throw new HttpError(400, 'Você não pode remover seu próprio acesso de administrador');
    add('role', c.role);
  }
  if ('department' in c) add('department', String(c.department || '').trim() || null);
  if ('checkin_mode' in c) {
    if (!['both', 'qr'].includes(c.checkin_mode)) throw new HttpError(400, 'Forma de check-in inválida');
    add('checkin_mode', c.checkin_mode);
  }
  if ('active' in c) {
    if (c.active === false && ids.includes(req.user.id)) throw new HttpError(400, 'Você não pode inativar o próprio usuário');
    add('active', c.active !== false);
  }
  if ('manager_id' in c) {
    const mid = c.manager_id ? Number(c.manager_id) : null;
    if (mid && ids.includes(mid)) throw new HttpError(400, 'O gestor escolhido está entre os selecionados — ninguém pode ser o próprio chefe');
    for (const id of ids) await assertNoManagerCycle(id, mid);
    add('manager_id', mid);
  }
  if (!sets.length) throw new HttpError(400, 'Marque ao menos um campo para alterar');

  params.push(ids);
  const { rowCount } = await query(`UPDATE users SET ${sets.join(', ')}, updated_at=now() WHERE id = ANY($${params.length}::int[])`, params);
  // O próprio admin nunca perde o acesso (validado acima), então sempre resta ao menos um administrador
  await audit(req.user.id, 'update', 'user', null, { batch: ids, changes: c });
  res.json({ ok: true, updated: rowCount });
}));

router.put('/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  const d = validate(req.body);
  await assertNoManagerCycle(id, d.manager_id);
  if (id === req.user.id && (d.role !== 'admin' || !d.active)) throw new HttpError(400, 'Você não pode remover seu próprio acesso de administrador');
  try {
    await query(
      `UPDATE users SET name=$1,email=$2,role=$3,department=$4,manager_id=$5,active=$6,checkin_mode=$7,updated_at=now() WHERE id=$8`,
      [d.name, d.email, d.role, d.department, d.manager_id, d.active, d.checkin_mode, id]
    );
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Já existe um usuário com este e-mail');
    throw e;
  }
  if (req.body.password) {
    if (req.body.password.length < 8) throw new HttpError(400, 'Senha deve ter ao menos 8 caracteres');
    await query('UPDATE users SET password_hash=$1, session_version=session_version+1 WHERE id=$2', [await bcrypt.hash(req.body.password, 10), id]);
  }
  await audit(req.user.id, 'update', 'user', id, { role: d.role, manager_id: d.manager_id, active: d.active, checkin_mode: d.checkin_mode });
  res.json({ ok: true });
}));

router.delete('/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Você não pode excluir o próprio usuário');
  const { rows: admins } = await query("SELECT id FROM users WHERE role='admin' AND active AND id<>$1", [id]);
  if (!admins.length) throw new HttpError(400, 'É necessário manter ao menos um administrador ativo');

  // Cancela reservas futuras (e eventos no Google) antes de excluir
  const { rows: future } = await query(
    "SELECT * FROM bookings WHERE user_id=$1 AND status='confirmed' AND starts_at > now()", [id]);
  for (const b of future) await google.deleteEvent(b);

  const { rows } = await tx(async (c) => {
    await c.query('UPDATE users SET manager_id=NULL WHERE manager_id=$1', [id]);
    return c.query('DELETE FROM users WHERE id=$1 RETURNING email', [id]);
  });
  if (!rows[0]) throw new HttpError(404, 'Usuário não encontrado');
  await audit(req.user.id, 'delete', 'user', id, { email: rows[0].email, futureBookingsRemoved: future.length });
  res.json({ ok: true });
}));

module.exports = router;
