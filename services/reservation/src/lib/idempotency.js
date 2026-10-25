'use strict';

const crypto = require('node:crypto');
const { pool, withTransaction } = require('../db');
const { conflict, unprocessable } = require('../errors');

class ReplaySignal extends Error {}

function hashRequest(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Runs `work(conn)` in a transaction. When a key is given, the key row is inserted first in the
 * same transaction: a concurrent request with the same key blocks on that row and, once the
 * first one commits, replays its stored response instead of executing twice.
 * `work` must return { status, body }.
 */
async function runIdempotent({ key, scope, requestHash }, work) {
  if (!key) return withTransaction(work);
  try {
    return await withTransaction(async (conn) => {
      try {
        await conn.query('INSERT INTO idempotency_keys (scope, idem_key, request_hash) VALUES (?, ?, ?)', [
          scope,
          key,
          requestHash,
        ]);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw new ReplaySignal();
        throw err;
      }
      const result = await work(conn);
      await conn.query('UPDATE idempotency_keys SET status_code = ?, response_body = ? WHERE scope = ? AND idem_key = ?', [
        result.status,
        JSON.stringify(result.body ?? null),
        scope,
        key,
      ]);
      return result;
    });
  } catch (err) {
    if (!(err instanceof ReplaySignal)) throw err;
    const [rows] = await pool.query(
      'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE scope = ? AND idem_key = ?',
      [scope, key],
    );
    const row = rows[0];
    if (!row || row.status_code === null) {
      throw conflict('IDEMPOTENCY_IN_PROGRESS', 'Yêu cầu cùng Idempotency-Key đang được xử lý, thử lại sau');
    }
    if (row.request_hash !== requestHash) {
      throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key đã được dùng cho một yêu cầu khác');
    }
    const body = typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body;
    return { status: row.status_code, body, replayed: true };
  }
}

module.exports = { runIdempotent, hashRequest };
