'use strict';

const crypto = require('node:crypto');
const { conflict, notFound } = require('../errors');

const RES_SELECT = `
  SELECT r.*, c.full_name AS customer_name, c.phone AS customer_phone,
         t.code AS table_code, t.name AS table_name, t.capacity AS table_capacity
    FROM reservations r
    JOIN customers c ON c.id = r.customer_id
    LEFT JOIN tables t ON t.id = r.table_id`;

// Statuses that hold a table; a CANCEL_PENDING booking keeps its table until its orders are cancelled.
const HOLDING = "('CONFIRMED', 'CANCEL_PENDING')";

async function loadReservation(conn, id) {
  const [[row]] = await conn.query(`${RES_SELECT} WHERE r.id = ?`, [id]);
  return row ?? null;
}

async function lockReservation(conn, id) {
  const [[row]] = await conn.query('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [id]);
  if (!row) throw notFound('RESERVATION_NOT_FOUND', 'Không tìm thấy đơn đặt bàn');
  return row;
}

function assertVersion(row, expected) {
  if (row.version !== expected) {
    throw conflict('VERSION_CONFLICT', 'Dữ liệu đã được người khác cập nhật, vui lòng tải lại', {
      currentVersion: row.version,
    });
  }
}

const STATUS_LABEL = {
  PENDING: 'chờ xác nhận',
  CONFIRMED: 'đã xác nhận',
  CANCEL_PENDING: 'đang hủy',
  CANCELLED: 'đã hủy',
};

function assertStatus(row, allowed, code = 'INVALID_STATE') {
  if (!allowed.includes(row.status)) {
    throw conflict(code, `Không thể thực hiện khi đơn đang ở trạng thái "${STATUS_LABEL[row.status]}"`, {
      status: row.status,
    });
  }
}

// Reuse a customer row only for the exact same (phone, name); otherwise keep them separate.
async function findOrCreateCustomer(conn, fullName, phone) {
  const [[existing]] = await conn.query('SELECT id FROM customers WHERE phone = ? AND full_name = ? LIMIT 1', [
    phone,
    fullName,
  ]);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await conn.query('INSERT INTO customers (id, full_name, phone) VALUES (?, ?, ?)', [id, fullName, phone]);
  return id;
}

async function lockTable(conn, tableId) {
  const [[row]] = await conn.query('SELECT * FROM tables WHERE id = ? FOR UPDATE', [tableId]);
  return row ?? null;
}

// Locked in a fixed order (capacity, code) so concurrent transactions cannot deadlock on each other.
async function lockSuitableTables(conn, branchId, partySize) {
  const [rows] = await conn.query(
    `SELECT * FROM tables WHERE branch_id = ? AND status = 'ACTIVE' AND capacity >= ?
      ORDER BY capacity, code, id FOR UPDATE`,
    [branchId, partySize],
  );
  return rows;
}

/** Bookings on the table whose [starts_at, ends_at) overlaps the given range. */
async function findConflicts(conn, tableId, startsAt, endsAt, excludeId = null) {
  const [rows] = await conn.query(
    `SELECT id, code, starts_at, ends_at FROM reservations
      WHERE table_id = ? AND status IN ${HOLDING} AND starts_at < ? AND ends_at > ? AND id <> ?
      ORDER BY starts_at`,
    [tableId, endsAt, startsAt, excludeId ?? ''],
  );
  return rows;
}

async function maxCapacity(conn, branchId) {
  const [[row]] = await conn.query(
    "SELECT MAX(capacity) AS cap FROM tables WHERE branch_id = ? AND status = 'ACTIVE'",
    [branchId],
  );
  return Number(row.cap ?? 0);
}

// Written inside the same transaction as the change it describes.
async function writeAudit(conn, { reservationId, action, from, to, user, requestId, details }) {
  await conn.query(
    `INSERT INTO audit_logs
       (reservation_id, action, from_status, to_status, actor_account_id, actor_role, actor_branch_id, request_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reservationId,
      action,
      from ?? null,
      to ?? null,
      user.accountId,
      user.role,
      user.branchId ?? null,
      requestId ?? null,
      details ? JSON.stringify(details) : null,
    ],
  );
}

async function loadHistory(conn, reservationId) {
  const [rows] = await conn.query('SELECT * FROM audit_logs WHERE reservation_id = ? ORDER BY created_at, id', [
    reservationId,
  ]);
  return rows.map((r) => ({
    action: r.action,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    actorAccountId: r.actor_account_id,
    actorRole: r.actor_role,
    details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
    createdAt: r.created_at,
  }));
}

module.exports = {
  RES_SELECT,
  HOLDING,
  loadReservation,
  lockReservation,
  assertVersion,
  assertStatus,
  findOrCreateCustomer,
  lockTable,
  lockSuitableTables,
  findConflicts,
  maxCapacity,
  writeAudit,
  loadHistory,
};
