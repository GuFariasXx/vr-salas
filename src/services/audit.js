const { query } = require('../db');

async function audit(userId, action, entity, entityId, details) {
  try {
    await query(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
      [userId || null, action, entity, entityId || null, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    console.error('[audit]', e.message);
  }
}

module.exports = { audit };
