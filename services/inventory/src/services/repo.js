'use strict';

const crypto = require('node:crypto');
const { conflict, notFound, unprocessable } = require('../errors');
const { mapItem, mapRequest, mapSlip, mapLine } = require('./mappers');

const SLIP_SELECT = (table) => `
  SELECT s.*, w.name AS warehouse_name, tr.code AS request_code, tr.status AS request_status,
         tr.reason AS request_reason, tr.requester_branch_id, tr.supplier_branch_id
    FROM ${table} s
    JOIN transfer_requests tr ON tr.id = s.request_id
    LEFT JOIN warehouses w ON w.id = s.warehouse_id`;

async function loadItems(conn, requestIds) {
  const byRequest = new Map();
  if (!requestIds.length) return byRequest;
  const [rows] = await conn.query(
    `SELECT ti.*, i.code AS ingredient_code, i.name AS ingredient_name, i.unit
       FROM transfer_items ti
       JOIN ingredients i ON i.id = ti.ingredient_id
      WHERE ti.request_id IN (?)
      ORDER BY i.name`,
    [requestIds],
  );
  for (const row of rows) {
    if (!byRequest.has(row.request_id)) byRequest.set(row.request_id, []);
    byRequest.get(row.request_id).push(mapItem(row));
  }
  return byRequest;
}

async function loadSlip(conn, table, where, params) {
  const [[row]] = await conn.query(`${SLIP_SELECT(table)} WHERE ${where}`, params);
  return row ? mapSlip(row) : null;
}

async function loadHistory(conn, transferId) {
  const [rows] = await conn.query(
    'SELECT * FROM audit_logs WHERE transfer_request_id = ? ORDER BY created_at, id',
    [transferId],
  );
  return rows.map((r) => ({
    action: r.action,
    entityType: r.entity_type,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    actorAccountId: r.actor_account_id,
    actorRole: r.actor_role,
    actorBranchId: r.actor_branch_id,
    details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
    createdAt: r.created_at,
  }));
}

async function loadDetail(conn, id) {
  const [[row]] = await conn.query('SELECT * FROM transfer_requests WHERE id = ?', [id]);
  if (!row) return null;
  const items = (await loadItems(conn, [id])).get(id) || [];
  const exportSlip = await loadSlip(conn, 'export_slips', 's.request_id = ?', [id]);
  const importSlip = await loadSlip(conn, 'import_slips', 's.request_id = ?', [id]);
  const history = await loadHistory(conn, id);
  return { raw: row, data: { ...mapRequest(row), items, exportSlip, importSlip, history } };
}

// Written inside the same transaction as the change it describes.
async function writeAudit(conn, { transferId, entityType = 'TRANSFER_REQUEST', entityId, action, from, to, user, requestId, details }) {
  await conn.query(
    `INSERT INTO audit_logs
       (transfer_request_id, entity_type, entity_id, action, from_status, to_status,
        actor_account_id, actor_role, actor_branch_id, request_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transferId,
      entityType,
      entityId ?? transferId,
      action,
      from ?? null,
      to ?? null,
      user.accountId,
      user.role,
      user.branchId,
      requestId ?? null,
      details ? JSON.stringify(details) : null,
    ],
  );
}

async function lockRequest(conn, id) {
  const [[row]] = await conn.query('SELECT * FROM transfer_requests WHERE id = ? FOR UPDATE', [id]);
  if (!row) throw notFound('TRANSFER_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu điều phối');
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
  PENDING_APPROVAL: 'chờ duyệt',
  APPROVED: 'đã duyệt',
  EXPORTED: 'đã xuất',
  IMPORTED: 'đã nhập',
  REJECTED: 'đã từ chối',
};

function assertStatus(row, allowed, code = 'INVALID_STATE') {
  if (!allowed.includes(row.status)) {
    throw conflict(code, `Không thể thực hiện khi yêu cầu đang ở trạng thái "${STATUS_LABEL[row.status]}"`, {
      status: row.status,
    });
  }
}

async function assertIngredientsExist(conn, items) {
  const ids = items.map((i) => i.ingredientId);
  const [rows] = await conn.query('SELECT id FROM ingredients WHERE id IN (?)', [ids]);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw unprocessable('INGREDIENT_NOT_FOUND', 'Có nguyên liệu không tồn tại', { ingredientIds: missing });
  }
}

async function insertItems(conn, requestId, items) {
  await conn.query('INSERT INTO transfer_items (id, request_id, ingredient_id, quantity, note) VALUES ?', [
    items.map((i) => [crypto.randomUUID(), requestId, i.ingredientId, i.quantity, i.note]),
  ]);
}

/**
 * Compares each requested line with the balance in one warehouse (comparison in SQL, DECIMAL-safe).
 * With lock=true the balance rows are locked FOR UPDATE until the transaction ends.
 * Returns { lines (API shape), raw (SQL strings for writes), shortages }.
 */
async function compareWithWarehouse(conn, requestId, warehouseId, { lock = false } = {}) {
  const [rows] = await conn.query(
    `SELECT ti.ingredient_id, i.name AS ingredient_name, i.unit, ti.quantity AS required,
            COALESCE(sb.quantity, 0) AS available,
            (COALESCE(sb.quantity, 0) >= ti.quantity) AS enough
       FROM transfer_items ti
       JOIN ingredients i ON i.id = ti.ingredient_id
       LEFT JOIN stock_balances sb ON sb.warehouse_id = ? AND sb.ingredient_id = ti.ingredient_id
      WHERE ti.request_id = ?
      ORDER BY ti.ingredient_id
      ${lock ? 'FOR UPDATE OF sb' : ''}`,
    [warehouseId, requestId],
  );
  const lines = rows.map(mapLine);
  return { lines, raw: rows, shortages: lines.filter((l) => !l.enough) };
}

async function recordMovement(conn, { warehouseId, ingredientId, delta, sourceType, sourceId, by }) {
  await conn.query(
    `INSERT INTO stock_movements
       (id, warehouse_id, ingredient_id, quantity_delta, balance_after, source_type, source_id, created_by)
     SELECT ?, warehouse_id, ingredient_id, ?, quantity, ?, ?, ?
       FROM stock_balances WHERE warehouse_id = ? AND ingredient_id = ?`,
    [crypto.randomUUID(), delta, sourceType, sourceId, by, warehouseId, ingredientId],
  );
}

module.exports = {
  SLIP_SELECT,
  loadItems,
  loadSlip,
  loadDetail,
  loadHistory,
  writeAudit,
  lockRequest,
  assertVersion,
  assertStatus,
  assertIngredientsExist,
  insertItems,
  compareWithWarehouse,
  recordMovement,
};
