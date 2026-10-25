'use strict';

const crypto = require('node:crypto');
const { pool } = require('../db');
const { badRequest, conflict, forbidden, notFound, unprocessable } = require('../errors');
const { parsePaging } = require('../lib/http');
const { assertBody, optionalId, oneOf } = require('../lib/validate');
const { runIdempotent, hashRequest } = require('../lib/idempotency');
const { isOwner, assertManagerOf } = require('../middleware/auth');
const { slipActions } = require('../policy');
const { makeCode, mapSlip } = require('./mappers');
const repo = require('./repo');

const TABLES = { export: 'export_slips', import: 'import_slips' };
const LABELS = { export: 'phiếu xuất', import: 'phiếu nhập' };

async function listSlips(kind, user, query) {
  const table = TABLES[kind];
  const { page, limit, offset } = parsePaging(query);
  const status = oneOf(query.status, ['PENDING', 'CONFIRMED'], 'status');

  let branchId = optionalId(query.branchId, 'branchId');
  if (!isOwner(user)) {
    if (branchId && branchId !== user.branchId) {
      throw forbidden('BRANCH_SCOPE_FORBIDDEN', `Bạn chỉ được xem ${LABELS[kind]} của chi nhánh mình`);
    }
    branchId = user.branchId;
  }

  const where = [];
  const params = [];
  if (branchId) {
    where.push('s.branch_id = ?');
    params.push(branchId);
  }
  if (status) {
    where.push('s.status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table} s ${whereSql}`, params);
  const [rows] = await pool.query(
    `${repo.SLIP_SELECT(table)} ${whereSql}
      ORDER BY (s.status = 'PENDING') DESC, s.created_at DESC, s.id
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const items = await repo.loadItems(pool, rows.map((r) => r.request_id));
  return {
    data: rows.map((r) => ({
      ...mapSlip(r),
      items: items.get(r.request_id) || [],
      allowedActions: slipActions(user, kind, r),
    })),
    meta: { page, limit, total: Number(total) },
  };
}

// Authorisation is checked before the idempotent section so a replay never leaks to another branch.
async function preCheck(kind, user, slipId) {
  const [[slip]] = await pool.query(`SELECT branch_id FROM ${TABLES[kind]} WHERE id = ?`, [slipId]);
  if (!slip) {
    throw notFound(`${kind.toUpperCase()}_SLIP_NOT_FOUND`, `Không tìm thấy ${LABELS[kind]}`);
  }
  assertManagerOf(user, slip.branch_id);
}

async function lockSlip(conn, kind, slipId, expectedVersion) {
  const [[slip]] = await conn.query(`SELECT * FROM ${TABLES[kind]} WHERE id = ? FOR UPDATE`, [slipId]);
  if (slip.status !== 'PENDING') {
    throw conflict('SLIP_ALREADY_CONFIRMED', `${LABELS[kind][0].toUpperCase()}${LABELS[kind].slice(1)} đã được xác nhận trước đó`);
  }
  repo.assertVersion(slip, expectedVersion);
  return slip;
}

async function itemsWithSlip(conn, kind, slipId, requestId) {
  const slip = await repo.loadSlip(conn, TABLES[kind], 's.id = ?', [slipId]);
  const items = (await repo.loadItems(conn, [requestId])).get(requestId) || [];
  // Confirmed slips have no further actions.
  return { ...slip, items, allowedActions: [] };
}

/**
 * Supplier confirms export: re-check stock under row locks, deduct every line or nothing,
 * then create the import slip for the requesting branch. One transaction in inventory_db.
 */
async function confirmExport(user, slipId, rawBody, expectedVersion, ctx) {
  assertBody(rawBody, []);
  await preCheck('export', user, slipId);
  return runIdempotent(
    { key: ctx.idempotencyKey, scope: `confirm-export:${slipId}`, requestHash: hashRequest({ slipId }) },
    async (conn) => {
      const slip = await lockSlip(conn, 'export', slipId, expectedVersion);
      const request = await repo.lockRequest(conn, slip.request_id);
      repo.assertStatus(request, ['APPROVED']);

      const { raw, shortages } = await repo.compareWithWarehouse(conn, request.id, slip.warehouse_id, {
        lock: true,
      });
      if (shortages.length) {
        throw conflict('INSUFFICIENT_STOCK', 'Kho không còn đủ nguyên liệu để xuất; không có thay đổi nào được ghi', {
          shortages,
        });
      }

      for (const line of raw) {
        const [result] = await conn.query(
          `UPDATE stock_balances SET quantity = quantity - ?
            WHERE warehouse_id = ? AND ingredient_id = ? AND quantity >= ?`,
          [line.required, slip.warehouse_id, line.ingredient_id, line.required],
        );
        if (result.affectedRows !== 1) {
          throw conflict('INSUFFICIENT_STOCK', 'Kho không còn đủ nguyên liệu để xuất; không có thay đổi nào được ghi');
        }
        await repo.recordMovement(conn, {
          warehouseId: slip.warehouse_id,
          ingredientId: line.ingredient_id,
          delta: `-${line.required}`,
          sourceType: 'EXPORT_SLIP',
          sourceId: slip.id,
          by: user.accountId,
        });
      }

      await conn.query(
        `UPDATE export_slips SET status = 'CONFIRMED', confirmed_by = ?, exported_at = NOW(3), version = version + 1
          WHERE id = ?`,
        [user.accountId, slip.id],
      );
      await conn.query("UPDATE transfer_requests SET status = 'EXPORTED', version = version + 1 WHERE id = ?", [
        request.id,
      ]);

      // Pre-select the requester's first active warehouse; the receiving manager may pick another.
      const [[defaultWarehouse]] = await conn.query(
        "SELECT id FROM warehouses WHERE branch_id = ? AND status = 'ACTIVE' ORDER BY created_at, id LIMIT 1",
        [request.requester_branch_id],
      );
      const importCode = makeCode('PN');
      await conn.query(
        `INSERT INTO import_slips (id, code, request_id, branch_id, warehouse_id, status, version)
         VALUES (?, ?, ?, ?, ?, 'PENDING', 1)`,
        [crypto.randomUUID(), importCode, request.id, request.requester_branch_id, defaultWarehouse?.id ?? null],
      );
      await repo.writeAudit(conn, {
        transferId: request.id,
        entityType: 'EXPORT_SLIP',
        entityId: slip.id,
        action: 'EXPORT_CONFIRMED',
        from: 'APPROVED',
        to: 'EXPORTED',
        user,
        requestId: ctx.requestId,
        details: { exportSlipCode: slip.code, warehouseId: slip.warehouse_id, importSlipCode: importCode },
      });

      return { status: 200, body: { data: await itemsWithSlip(conn, 'export', slip.id, request.id) } };
    },
  );
}

async function confirmImport(user, slipId, rawBody, expectedVersion, ctx) {
  const body = assertBody(rawBody, ['warehouseId']);
  const requestedWarehouseId = optionalId(body.warehouseId, 'warehouseId');
  await preCheck('import', user, slipId);

  return runIdempotent(
    {
      key: ctx.idempotencyKey,
      scope: `confirm-import:${slipId}`,
      requestHash: hashRequest({ slipId, warehouseId: requestedWarehouseId }),
    },
    async (conn) => {
      const slip = await lockSlip(conn, 'import', slipId, expectedVersion);
      const warehouseId = requestedWarehouseId || slip.warehouse_id;
      if (!warehouseId) throw badRequest('WAREHOUSE_REQUIRED', 'Cần chọn kho nhận hàng', { field: 'warehouseId' });

      const [[warehouse]] = await conn.query('SELECT * FROM warehouses WHERE id = ?', [warehouseId]);
      if (!warehouse || warehouse.branch_id !== slip.branch_id) {
        throw unprocessable('WAREHOUSE_NOT_IN_BRANCH', 'Kho nhận không thuộc chi nhánh của bạn', { warehouseId });
      }
      if (warehouse.status !== 'ACTIVE') {
        throw unprocessable('WAREHOUSE_INACTIVE', 'Kho nhận đang ngừng hoạt động', { warehouseId });
      }

      const request = await repo.lockRequest(conn, slip.request_id);
      repo.assertStatus(request, ['EXPORTED']);

      const [items] = await conn.query(
        'SELECT ingredient_id, quantity FROM transfer_items WHERE request_id = ? ORDER BY ingredient_id',
        [request.id],
      );
      for (const item of items) {
        await conn.query(
          `INSERT INTO stock_balances (warehouse_id, ingredient_id, quantity) VALUES (?, ?, ?) AS incoming
           ON DUPLICATE KEY UPDATE quantity = stock_balances.quantity + incoming.quantity`,
          [warehouseId, item.ingredient_id, item.quantity],
        );
        await repo.recordMovement(conn, {
          warehouseId,
          ingredientId: item.ingredient_id,
          delta: item.quantity,
          sourceType: 'IMPORT_SLIP',
          sourceId: slip.id,
          by: user.accountId,
        });
      }

      await conn.query(
        `UPDATE import_slips
            SET status = 'CONFIRMED', warehouse_id = ?, confirmed_by = ?, imported_at = NOW(3), version = version + 1
          WHERE id = ?`,
        [warehouseId, user.accountId, slip.id],
      );
      await conn.query("UPDATE transfer_requests SET status = 'IMPORTED', version = version + 1 WHERE id = ?", [
        request.id,
      ]);
      await repo.writeAudit(conn, {
        transferId: request.id,
        entityType: 'IMPORT_SLIP',
        entityId: slip.id,
        action: 'IMPORT_CONFIRMED',
        from: 'EXPORTED',
        to: 'IMPORTED',
        user,
        requestId: ctx.requestId,
        details: { importSlipCode: slip.code, warehouseId },
      });

      return { status: 200, body: { data: await itemsWithSlip(conn, 'import', slip.id, request.id) } };
    },
  );
}

module.exports = { listSlips, confirmExport, confirmImport };
