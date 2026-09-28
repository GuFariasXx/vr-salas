const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl });

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  const { rows } = await pool.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (!rows.length) {
    const hash = await bcrypt.hash(config.admin.password, 10);
    await pool.query(
      `INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'admin')
       ON CONFLICT (email) DO UPDATE SET role='admin'`,
      [config.admin.name, config.admin.email, hash]
    );
    console.log(`[db] Admin inicial criado: ${config.admin.email}`);
  }
}

module.exports = { pool, query, tx, migrate };
