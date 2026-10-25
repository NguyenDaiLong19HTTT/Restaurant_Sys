'use strict';

const mysql = require('mysql2/promise');
const config = require('./config');

function connectionOptions(extra = {}) {
  const common = {
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    // DECIMAL stays a string so quantities never pass through float math.
    decimalNumbers: false,
    ...extra,
  };
  return config.databaseUrl ? { uri: config.databaseUrl, ...common } : { ...config.db, ...common };
}

const pool = mysql.createPool(connectionOptions({ waitForConnections: true, connectionLimit: 10 }));

pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

async function withTransaction(work, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (RETRYABLE.has(err.code) && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

module.exports = { pool, withTransaction, connectionOptions };
