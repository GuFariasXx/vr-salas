const router = require('express').Router();
const { query } = require('../db');
const { requireAdmin, h, HttpError } = require('../middleware');
const { audit } = require('../services/audit');
const QRCode = require('qrcode');
const config = require('../config');
const { esc } = require('../services/mail');

const checkinUrl = (token) => `${config.appUrl}/checkin?t=${token}`;

router.get('/', h(async (req, res) => {
  const all = req.user.role === 'admin' && req.query.all === '1';
  const { rows } = await query(
    `SELECT r.*,
       (SELECT json_build_object('id',b.id,'title',b.title,'ends_at',b.ends_at,'user_name',u.name,'status',b.status)
          FROM bookings b JOIN users u ON u.id=b.user_id
         WHERE b.room_id=r.id AND b.status IN ('confirmed','checked_in') AND now() >= b.starts_at AND now() < b.ends_at
         LIMIT 1) AS current_booking,
       (SELECT min(b.starts_at) FROM bookings b
         WHERE b.room_id=r.id AND b.status IN ('confirmed','checked_in') AND b.starts_at > now()
           AND b.starts_at::date = now()::date) AS next_start
     FROM rooms r ${all ? '' : 'WHERE r.active'} ORDER BY r.name`
  );
  // O token do QR só é visível para administradores (evita check-in à distância)
  if (req.user.role !== 'admin') rows.forEach((r) => delete r.checkin_token);
  res.json(rows);
}));

function validate(b) {
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'Nome da sala é obrigatório');
  const capacity = Number(b.capacity);
  if (!Number.isInteger(capacity) || capacity < 1) throw new HttpError(400, 'Capacidade inválida');
  const open = b.open_time || '08:00', close = b.close_time || '18:00';
  if (open >= close) throw new HttpError(400, 'Horário de abertura deve ser anterior ao de fechamento');
  const resources = Array.isArray(b.resources) ? b.resources.map((s) => String(s).trim()).filter(Boolean) : [];
  return [name, b.location || null, capacity, resources, b.color || '#E8620E', open, close,
    b.requires_checkin !== false, b.google_resource_email || null, b.description || null, b.active !== false];
}

router.post('/', requireAdmin, h(async (req, res) => {
  try {
    const { rows } = await query(
      `INSERT INTO rooms (name,location,capacity,resources,color,open_time,close_time,requires_checkin,google_resource_email,description,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, validate(req.body));
    await audit(req.user.id, 'create', 'room', rows[0].id, { name: req.body.name });
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Já existe uma sala com este nome');
    throw e;
  }
}));

router.put('/:id', requireAdmin, h(async (req, res) => {
  try {
    await query(
      `UPDATE rooms SET name=$1,location=$2,capacity=$3,resources=$4,color=$5,open_time=$6,close_time=$7,
         requires_checkin=$8,google_resource_email=$9,description=$10,active=$11 WHERE id=$12`,
      [...validate(req.body), Number(req.params.id)]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Já existe uma sala com este nome');
    throw e;
  }
  await audit(req.user.id, 'update', 'room', Number(req.params.id));
  res.json({ ok: true });
}));

router.delete('/:id', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query("SELECT count(*)::int n FROM bookings WHERE room_id=$1 AND status='confirmed' AND starts_at > now()", [id]);
  if (rows[0].n > 0 && req.query.force !== '1') {
    throw new HttpError(409, `A sala possui ${rows[0].n} reserva(s) futura(s). Desative a sala ou cancele as reservas antes.`);
  }
  await query('DELETE FROM rooms WHERE id=$1', [id]);
  await audit(req.user.id, 'delete', 'room', id);
  res.json({ ok: true });
}));

// ---------- QR code de check-in ----------
async function roomOr404(id) {
  const { rows } = await query('SELECT * FROM rooms WHERE id=$1', [Number(id)]);
  if (!rows[0]) throw new HttpError(404, 'Sala não encontrada');
  return rows[0];
}

router.get('/:id/qr.svg', requireAdmin, h(async (req, res) => {
  const r = await roomOr404(req.params.id);
  const svg = await QRCode.toString(checkinUrl(r.checkin_token), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#27272A', light: '#FFFFFF' } });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
}));

// Página pronta para imprimir e colar na porta da sala
router.get('/:id/qr/print', requireAdmin, h(async (req, res) => {
  const r = await roomOr404(req.params.id);
  const url = checkinUrl(r.checkin_token);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#27272A', light: '#FFFFFF' } });
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>QR check-in · ${esc(r.name)}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap">
  <style>
    @page{size:A5 portrait;margin:0}
    *{box-sizing:border-box}body{margin:0;font-family:Roboto,Arial,sans-serif;color:#27272A;background:#F4F4F5}
    .sheet{width:148mm;min-height:210mm;margin:10mm auto;background:#fff;display:flex;flex-direction:column}
    .top{background:linear-gradient(135deg,#FF7A00,#F25A05 45%,#C93400);color:#fff;padding:12mm 12mm 10mm;display:flex;align-items:center;gap:4mm}
    .top img{width:14mm;height:14mm}.top b{font-size:9mm;letter-spacing:.5px}
    .body{flex:1;padding:10mm 12mm;text-align:center;display:flex;flex-direction:column;align-items:center}
    h1{margin:0;font-size:11mm;font-weight:700}.loc{color:#71717A;font-size:4.5mm;margin-top:1.5mm}
    .qr{width:86mm;height:86mm;margin:8mm 0 6mm}.qr svg{width:100%;height:100%}
    .cta{font-size:6mm;font-weight:500}.help{color:#52525B;font-size:4mm;line-height:1.5;margin-top:3mm;max-width:110mm}
    .foot{padding:5mm 12mm;border-top:1px solid #E4E4E7;display:flex;justify-content:space-between;color:#71717A;font-size:3.2mm}
    .actions{text-align:center;margin:6mm}.actions button{font:500 14px Roboto,Arial;background:#E8620E;color:#fff;border:0;border-radius:6px;padding:10px 18px;cursor:pointer}
    @media print{body{background:#fff}.sheet{margin:0}.actions{display:none}}
  </style></head><body>
  <div class="actions"><button id="print">Imprimir</button></div>
  <div class="sheet">
    <div class="top"><img src="/img/logo.svg" alt=""><b>VR SALAS</b></div>
    <div class="body">
      <h1>${esc(r.name)}</h1>${r.location ? `<div class="loc">${esc(r.location)}</div>` : ''}
      <div class="qr">${svg}</div>
      <div class="cta">Aponte a câmera para fazer o check-in</div>
      <div class="help">Use a câmera do celular ou o botão <b>Check-in por QR</b> no VR Salas.<br>
        O check-in abre alguns minutos antes da reunião. Sem check-in, a sala é liberada e o gestor é avisado.</div>
    </div>
    <div class="foot"><span>VR Software · Simplifique</span><span>${esc(config.appUrl.replace(/^https?:\/\//, ''))}</span></div>
  </div>
  <script src="/js/print.js"></script></body></html>`);
}));

router.post('/:id/qr/regenerate', requireAdmin, h(async (req, res) => {
  await roomOr404(req.params.id);
  await query("UPDATE rooms SET checkin_token=replace(gen_random_uuid()::text,'-','') WHERE id=$1", [Number(req.params.id)]);
  await audit(req.user.id, 'update', 'room', Number(req.params.id), { qr: 'regenerated' });
  res.json({ ok: true });
}));

module.exports = router;
