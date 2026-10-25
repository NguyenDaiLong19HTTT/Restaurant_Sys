'use strict';

const crypto = require('node:crypto');
const pool = require('../db/pool');
const HttpError = require('../domain/http-error');

function summary(row) {
  return {
    id: row.id, code: row.code, branchId: row.branch_id,
    reservationId: row.reservation_id, tableId: row.table_id,
    serviceType: row.service_type, status: row.status,
    paymentStatus: row.payment_status || 'UNPAID',
    ...(row.item_count !== undefined ? { itemCount: Number(row.item_count) } : {}),
    totalVnd: Number(row.total_vnd), version: Number(row.version),
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function detail(row, items, takeaway) {
  return {
    ...summary(row),
    itemCount: items.length,
    items: items.map((item) => ({
      id: item.id, dishId: item.dish_id, dishNameSnapshot: item.dish_name_snapshot,
      unitPriceVnd: Number(item.unit_price_vnd), quantity: Number(item.quantity), lineTotalVnd: Number(item.line_total_vnd)
    })),
    takeaway: takeaway ? {
      recipientName: takeaway.recipient_name, recipientPhone: takeaway.recipient_phone, handoverAt: takeaway.handover_at
    } : null
  };
}

async function getDetail(id, connection = pool) {
  const [[order]] = await connection.execute('SELECT * FROM orders WHERE id = ?', [id]);
  if (!order) return null;
  const [items] = await connection.execute('SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at, id', [id]);
  const [details] = await connection.execute('SELECT * FROM takeaway_details WHERE order_id = ?', [id]);

  return {...detail(order,items,details[0]),paidPaymentId:order.paid_payment_id,paymentLocked:Boolean(order.payment_lock_id)};
}

async function findScoped(id, user, { lock = false, connection = pool } = {}) {
  const [rows] = await connection.execute(`SELECT * FROM orders WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  const order = rows[0];
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order was not found');
  if (user.role !== 'CHU_CHUOI' && order.branch_id !== user.branchId) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order was not found');
  return order;
}

async function list({ branchId, tableId, status, page, limit }) {
  const conditions = [];
  const values = [];
  if (branchId) { conditions.push('branch_id = ?'); values.push(branchId); }
  if (tableId) { conditions.push('table_id = ?'); values.push(tableId); }
  if (status) { conditions.push('status = ?'); values.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [[count]] = await pool.execute(`SELECT COUNT(*) AS total FROM orders ${where}`, values);
  const [rows] = await pool.execute(`SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count FROM orders o ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit]);
  return { data: rows.map(summary), meta: { page, limit, total: Number(count.total) } };
}

async function withTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function updateTotal(connection,orderId){
 const [[r]]=await connection.execute('SELECT COALESCE(SUM(line_total_vnd),0) AS total FROM order_items WHERE order_id=?',[orderId]);
 const total=BigInt(r.total);if(total>9999999999n)throw new HttpError(422,'AMOUNT_TOO_LARGE','Tổng order vượt giới hạn số nguyên VND được hỗ trợ');
 await connection.execute('UPDATE orders SET total_vnd=? WHERE id=?',[total.toString(),orderId]);
}

async function addIdempotencyRecord(connection, { scope, key, requestHash }) {
  const [rows] = await connection.execute('SELECT request_hash, response_status, response_body FROM idempotency_records WHERE scope = ? AND idempotency_key = ? FOR UPDATE', [scope, key]);
  if (rows.length) {
    if (rows[0].request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    if (rows[0].response_status && rows[0].response_body) return { replay: true, status: rows[0].response_status, body: rows[0].response_body };
    return { replay: false };
  }
  await connection.execute('INSERT INTO idempotency_records (scope, idempotency_key, request_hash) VALUES (?, ?, ?)', [scope, key, requestHash]);
  return { replay: false };
}

async function saveIdempotentResponse(connection, { scope, key, status, body }) {
  await connection.execute('UPDATE idempotency_records SET response_status = ?, response_body = ? WHERE scope = ? AND idempotency_key = ?', [status, JSON.stringify(body), scope, key]);
}

async function findReservationOrders(reservationId) {
  const [rows] = await pool.execute('SELECT id, status FROM orders WHERE reservation_id = ?', [reservationId]);
  return rows.map((row) => ({ id: row.id, status: row.status, cancellable: row.status === 'DRAFT' }));
}

function requestHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

module.exports = {
  pool, summary, getDetail, findScoped, list, withTransaction,
  updateTotal, addIdempotencyRecord, saveIdempotentResponse,
  findReservationOrders, requestHash
};
