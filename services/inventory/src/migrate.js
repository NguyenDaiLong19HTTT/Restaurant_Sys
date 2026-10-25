'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('./config');
const logger = require('./logger');
const { connectionOptions } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const SEEDS_DIR = path.join(__dirname, '..', 'seeds');

async function applyDir(conn, dir, prefix) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const [rows] = await conn.query('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => r.version));
  for (const file of files) {
    const version = `${prefix}:${file}`;
    if (done.has(version)) continue;
    const sql=fs.readFileSync(path.join(dir,file),'utf8');
    if(prefix==='migration') {
      await require('../../../packages/sql-migrate.cjs').apply(conn,sql);
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
    } else {
      // Seed rows and its ledger commit together: safe even after an interrupted run.
      await conn.beginTransaction();
      try {
        await conn.query(sql.replace(/^\s*(?:START TRANSACTION|COMMIT)\s*;/gmi,''));
        await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
        await conn.commit();
      } catch(error) { await conn.rollback(); throw error; }
    }
    logger.info('applied sql file', { version });
  }
}

async function runMigrations() {
  const conn = await mysql.createConnection(connectionOptions({ multipleStatements: true }));
  try {
    // Serialise migrations if several replicas start at once.
    await conn.query("SELECT GET_LOCK('inventory_migrations', 60)");
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(150) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`);
    await applyDir(conn, MIGRATIONS_DIR, 'migration');
    if (config.seedDemoData) await applyDir(conn, SEEDS_DIR, 'seed');
    await conn.query("SELECT RELEASE_LOCK('inventory_migrations')");
  } finally {
    await conn.end();
  }
}

module.exports = { runMigrations };
