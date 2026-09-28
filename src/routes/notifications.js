const router = require('express').Router();
const { query } = require('../db');
const { h } = require('../middleware');

router.get('/', h(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  const unread = rows.filter((n) => !n.read_at).length;
  res.json({ unread, items: rows });
}));

router.post('/read-all', h(async (req, res) => {
  await query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));

router.post('/:id/read', h(async (req, res) => {
  await query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
