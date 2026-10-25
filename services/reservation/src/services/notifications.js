'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../logger');
const { pool, withTransaction } = require('../db');
const { forbidden } = require('../errors');
const { parsePaging } = require('../lib/http');
const { formatLocal } = require('../lib/time');
const { oneOf, optionalId } = require('../lib/validate');
const { mapNotification } = require('./mappers');

const MAX_CONTENT = 500;
const clip = (text) => (text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text);

// Message texts follow the use case specs (UC01, UC02, UC03, UC04).
const TEMPLATES = {
  CREATED: {
    SMS: (r) =>
      `Nhà hàng Nhóm 6: đã nhận yêu cầu đặt bàn ${r.code} lúc ${formatLocal(r.startsAt)} cho ${r.partySize} khách. ` +
      'Nhân viên sẽ liên hệ xác nhận trong thời gian sớm nhất.',
    STAFF: (r) => `Đơn đặt bàn mới ${r.code}: ${r.partySize} khách lúc ${formatLocal(r.startsAt)}, đang chờ xác nhận.`,
  },
  CONFIRMED: {
    SMS: (r) =>
      `Nhà hàng Nhóm 6: đơn đặt bàn ${r.code} đã được xác nhận. Bàn ${r.tableName}, ${formatLocal(r.startsAt)}, ` +
      `${r.partySize} khách. Hẹn gặp quý khách!`,
  },
  UPDATED: {
    SMS: (r) =>
      `Đơn đặt bàn của quý khách đã được cập nhật thành công: ${r.code}, ${formatLocal(r.startsAt)}, ${r.partySize} khách` +
      `${r.tableName ? `, bàn ${r.tableName}` : ''}.`,
  },
  CANCELLED: {
    SMS: (r) => `Đơn đặt bàn của quý khách đã bị hủy: ${r.code}. Lý do: ${r.reason}`,
  },
};

/**
 * Writes outbox rows in the caller's transaction, so a message exists if and only if the change committed.
 * r = { id, code, branchId, phone, startsAt, partySize, tableName?, reason? }
 */
async function enqueue(conn, event, r) {
  const rows = [];
  if (TEMPLATES[event].SMS) rows.push(['SMS', r.phone, TEMPLATES[event].SMS(r)]);
  if (TEMPLATES[event].STAFF) rows.push(['STAFF', `branch:${r.branchId}`, TEMPLATES[event].STAFF(r)]);
  for (const [channel, recipient, content] of rows) {
    await conn.query(
      `INSERT INTO notifications (id, reservation_id, branch_id, channel, recipient, event, content)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), r.id, r.branchId, channel, recipient, event, clip(content)],
    );
  }
}

async function listForBranch(user, query) {
  const { page, limit, offset } = parsePaging(query);
  const channel = oneOf(query.channel, ['SMS', 'STAFF'], 'channel');
  const branchId = optionalId(query.branchId, 'branchId') ?? user.branchId;
  if (branchId !== user.branchId) {
    throw forbidden('BRANCH_SCOPE_FORBIDDEN', 'Bạn chỉ được xem thông báo của chi nhánh mình');
  }
  const where = ['n.branch_id = ?'];
  const params = [branchId];
  if (channel) {
    where.push('n.channel = ?');
    params.push(channel);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM notifications n ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT n.*, r.code AS reservation_code FROM notifications n JOIN reservations r ON r.id = n.reservation_id
      ${whereSql} ORDER BY n.created_at DESC, n.id LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { data: rows.map(mapNotification), meta: { page, limit, total: Number(total) } };
}

// Adapters: plug a real SMS provider in here. The simulator never claims a real SMS was sent.
const ADAPTERS = {
  simulator: async () => 'SIMULATED',
};

async function dispatchPending(batchSize = 50) {
  const adapter = ADAPTERS[config.notificationAdapter] ?? ADAPTERS.simulator;
  return withTransaction(async (conn) => {
    // SKIP LOCKED lets several replicas share the outbox without sending a message twice.
    const [rows] = await conn.query(
      "SELECT * FROM notifications WHERE status = 'PENDING' ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED",
      [batchSize],
    );
    for (const row of rows) {
      try {
        const status = await adapter(row);
        await conn.query(
          'UPDATE notifications SET status = ?, attempts = attempts + 1, processed_at = NOW(3) WHERE id = ?',
          [status, row.id],
        );
      } catch (err) {
        logger.warn('notification failed', { notificationId: row.id, err: err.message });
        // MySQL applies SET left to right, so `attempts` below is already the incremented value.
        await conn.query(
          `UPDATE notifications SET attempts = attempts + 1, last_error = ?,
                  status = IF(attempts >= 5, 'FAILED', 'PENDING') WHERE id = ?`,
          [err.message.slice(0, 255), row.id],
        );
      }
    }
    return rows.length;
  });
}

module.exports = { enqueue, listForBranch, dispatchPending };
