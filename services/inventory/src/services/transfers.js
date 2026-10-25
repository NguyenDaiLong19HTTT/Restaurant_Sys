'use strict';

const crypto = require('node:crypto');
const { pool, withTransaction } = require('../db');
const { badRequest, forbidden, notFound, unprocessable } = require('../errors');
const { parsePaging } = require('../lib/http');
const { LIMITS, assertBody, requiredId, optionalId, requiredString, oneOf, parseItems } = require('../lib/validate');
const { runIdempotent, hashRequest } = require('../lib/idempotency');
const { getBranch, assertActiveBranch } = require('../lib/branchClient');
const { isOwner } = require('../middleware/auth');
const { canViewTransfer, isRequesterManager, transferActions } = require('../policy');
const { makeCode, mapRequest, mapLine } = require('./mappers');
const repo = require('./repo');

const STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'EXPORTED', 'IMPORTED', 'REJECTED'];

const present = (user, detail) => ({ ...detail.data, allowedActions: transferActions(user, detail.raw) });

function assertRequesterManager(user, row) {
  if (isRequesterManager(user, row)) return;
  throw forbidden('BRANCH_SCOPE_FORBIDDEN', 'Chỉ quản lý chi nhánh tạo yêu cầu mới được sửa hoặc xóa');
}

async function listRequests(user, query) {
  const { page, limit, offset } = parsePaging(query);
  const status = oneOf(query.status, STATUSES, 'status');
  const side = oneOf(query.side, ['requester', 'supplier'], 'side');

  let branchId = optionalId(query.branchId, 'branchId');
  if (!isOwner(user)) {
    if (branchId && branchId !== user.branchId) {
      throw forbidden('BRANCH_SCOPE_FORBIDDEN', 'Bạn chỉ được xem yêu cầu của chi nhánh mình');
    }
    branchId = user.branchId;
  }

  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (branchId) {
    if (side === 'requester') where.push('requester_branch_id = ?');
    else if (side === 'supplier') where.push('supplier_branch_id = ?');
    else {
      where.push('(requester_branch_id = ? OR supplier_branch_id = ?)');
      params.push(branchId);
    }
    params.push(branchId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM transfer_requests ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT * FROM transfer_requests ${whereSql} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const items = await repo.loadItems(pool, rows.map((r) => r.id));
  return {
    data: rows.map((r) => ({ ...mapRequest(r), items: items.get(r.id) || [], allowedActions: transferActions(user, r) })),
    meta: { page, limit, total: Number(total) },
  };
}

async function getRequest(user, id) {
  const detail = await repo.loadDetail(pool, id);
  if (!detail) throw notFound('TRANSFER_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu điều phối');
  if (!canViewTransfer(user, detail.raw)) {
    throw forbidden('BRANCH_SCOPE_FORBIDDEN', 'Yêu cầu này không thuộc phạm vi chi nhánh của bạn');
  }
  return present(user, detail);
}

async function createRequest(user, rawBody, ctx) {
  const body = assertBody(rawBody, ['branchId', 'reason', 'items']);
  // The branch always comes from the token; a different branchId in the body is rejected, not ignored.
  const branchId = body.branchId ?? user.branchId;
  if (branchId !== user.branchId) {
    throw forbidden('BRANCH_SCOPE_FORBIDDEN', 'Chỉ được tạo yêu cầu cho chi nhánh của mình');
  }
  const reason = requiredString(body.reason, 'reason', LIMITS.reason);
  const items = parseItems(body.items);
  await assertActiveBranch(branchId, ctx.requestId);

  const id = crypto.randomUUID();
  return runIdempotent(
    {
      key: ctx.idempotencyKey,
      scope: `create-transfer:${user.accountId}`,
      requestHash: hashRequest({ branchId, reason, items }),
    },
    async (conn) => {
      const [[{ active }]] = await conn.query(
        "SELECT COUNT(*) AS active FROM warehouses WHERE branch_id = ? AND status = 'ACTIVE'",
        [branchId],
      );
      if (!Number(active)) {
        throw unprocessable('NO_ACTIVE_WAREHOUSE', 'Chi nhánh chưa có kho đang hoạt động để nhận hàng');
      }
      await repo.assertIngredientsExist(conn, items);
      await conn.query(
        `INSERT INTO transfer_requests (id, code, requester_branch_id, reason, status, version, created_by)
         VALUES (?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?)`,
        [id, makeCode('DP'), branchId, reason, user.accountId],
      );
      await repo.insertItems(conn, id, items);
      await repo.writeAudit(conn, {
        transferId: id,
        action: 'CREATED',
        to: 'PENDING_APPROVAL',
        user,
        requestId: ctx.requestId,
        details: { itemCount: items.length },
      });
      return { status: 201, body: { data: present(user, await repo.loadDetail(conn, id)) } };
    },
  );
}

async function updateRequest(user, id, rawBody, expectedVersion, ctx) {
  const body = assertBody(rawBody, ['reason', 'items']);
  const hasReason = body.reason !== undefined;
  const hasItems = body.items !== undefined;
  if (!hasReason && !hasItems) {
    throw badRequest('VALIDATION_ERROR', 'Cần gửi ít nhất một trong hai trường reason hoặc items');
  }
  const reason = hasReason ? requiredString(body.reason, 'reason', LIMITS.reason) : null;
  const items = hasItems ? parseItems(body.items) : null;

  return withTransaction(async (conn) => {
    const row = await repo.lockRequest(conn, id);
    assertRequesterManager(user, row);
    repo.assertStatus(row, ['PENDING_APPROVAL'], 'REQUEST_NOT_EDITABLE');
    repo.assertVersion(row, expectedVersion);
    if (items) {
      await repo.assertIngredientsExist(conn, items);
      await conn.query('DELETE FROM transfer_items WHERE request_id = ?', [id]);
      await repo.insertItems(conn, id, items);
    }
    await conn.query('UPDATE transfer_requests SET reason = COALESCE(?, reason), version = version + 1 WHERE id = ?', [
      reason,
      id,
    ]);
    await repo.writeAudit(conn, {
      transferId: id,
      action: 'UPDATED',
      from: row.status,
      to: row.status,
      user,
      requestId: ctx.requestId,
      details: { reasonChanged: hasReason, itemsChanged: hasItems },
    });
    return present(user, await repo.loadDetail(conn, id));
  });
}

async function deleteRequest(user, id, expectedVersion, ctx) {
  await withTransaction(async (conn) => {
    const row = await repo.lockRequest(conn, id);
    assertRequesterManager(user, row);
    repo.assertStatus(row, ['PENDING_APPROVAL'], 'REQUEST_NOT_EDITABLE');
    repo.assertVersion(row, expectedVersion);
    const items = (await repo.loadItems(conn, [id])).get(id) || [];
    // Snapshot kept in the audit log because the request row itself is removed.
    await repo.writeAudit(conn, {
      transferId: id,
      action: 'DELETED',
      from: row.status,
      user,
      requestId: ctx.requestId,
      details: {
        code: row.code,
        reason: row.reason,
        items: items.map((i) => ({ ingredientId: i.ingredientId, quantity: i.quantity })),
      },
    });
    await conn.query('DELETE FROM transfer_requests WHERE id = ?', [id]);
  });
}

/**
 * For the owner: every other branch's active warehouses with per-line availability.
 * A branch is eligible when it is ACTIVE and at least one of its warehouses holds the whole list,
 * because one export slip is issued from exactly one warehouse.
 */
async function eligibleBranches(user, id, ctx) {
  const detail = await repo.loadDetail(pool, id);
  if (!detail) throw notFound('TRANSFER_REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu điều phối');

  const [rows] = await pool.query(
    `SELECT w.id AS warehouse_id, w.name AS warehouse_name, w.branch_id,
            ti.ingredient_id, i.name AS ingredient_name, i.unit, ti.quantity AS required,
            COALESCE(sb.quantity, 0) AS available,
            (COALESCE(sb.quantity, 0) >= ti.quantity) AS enough
       FROM warehouses w
       JOIN transfer_items ti ON ti.request_id = ?
       JOIN ingredients i ON i.id = ti.ingredient_id
       LEFT JOIN stock_balances sb ON sb.warehouse_id = w.id AND sb.ingredient_id = ti.ingredient_id
      WHERE w.status = 'ACTIVE' AND w.branch_id <> ?
      ORDER BY w.branch_id, w.created_at, w.id, i.name`,
    [id, detail.raw.requester_branch_id],
  );

  const branches = new Map();
  for (const r of rows) {
    if (!branches.has(r.branch_id)) branches.set(r.branch_id, { branchId: r.branch_id, warehouses: new Map() });
    const warehouses = branches.get(r.branch_id).warehouses;
    if (!warehouses.has(r.warehouse_id)) {
      warehouses.set(r.warehouse_id, { warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, lines: [] });
    }
    warehouses.get(r.warehouse_id).lines.push(mapLine(r));
  }

  const result = await Promise.all(
    [...branches.values()].map(async (b) => {
      const info = await getBranch(b.branchId, ctx.requestId);
      const active = info?.status === 'ACTIVE';
      const warehouses = [...b.warehouses.values()].map((w) => ({
        ...w,
        eligible: active && w.lines.every((l) => l.enough),
      }));
      return {
        branchId: b.branchId,
        branchName: info?.name??null,
        branchStatus: info?.status ?? 'UNKNOWN',
        eligible: warehouses.some((w) => w.eligible),
        warehouses,
      };
    }),
  );
  result.sort((a, b) => Number(b.eligible) - Number(a.eligible));

  return {
    requestId: id,
    requestStatus: detail.raw.status,
    version: detail.raw.version,
    items: detail.data.items,
    branches: result,
  };
}

async function approveRequest(user, id, rawBody, expectedVersion, ctx) {
  const body = assertBody(rawBody, ['supplierBranchId', 'warehouseId']);
  const supplierBranchId = requiredId(body.supplierBranchId, 'supplierBranchId');
  const warehouseId = requiredId(body.warehouseId, 'warehouseId');
  await assertActiveBranch(supplierBranchId, ctx.requestId);

  return runIdempotent(
    {
      key: ctx.idempotencyKey,
      scope: `approve-transfer:${id}`,
      requestHash: hashRequest({ supplierBranchId, warehouseId }),
    },
    async (conn) => {
      const row = await repo.lockRequest(conn, id);
      repo.assertStatus(row, ['PENDING_APPROVAL']);
      repo.assertVersion(row, expectedVersion);
      if (supplierBranchId === row.requester_branch_id) {
        throw unprocessable('SUPPLIER_SAME_AS_REQUESTER', 'Chi nhánh cấp phải khác chi nhánh yêu cầu');
      }
      const [[warehouse]] = await conn.query('SELECT * FROM warehouses WHERE id = ?', [warehouseId]);
      if (!warehouse || warehouse.branch_id !== supplierBranchId) {
        throw unprocessable('WAREHOUSE_NOT_IN_BRANCH', 'Kho được chọn không thuộc chi nhánh cấp', { warehouseId });
      }
      if (warehouse.status !== 'ACTIVE') {
        throw unprocessable('WAREHOUSE_INACTIVE', 'Kho được chọn đang ngừng hoạt động', { warehouseId });
      }
      const { shortages } = await repo.compareWithWarehouse(conn, id, warehouseId);
      if (shortages.length) {
        throw unprocessable('SUPPLIER_NOT_ELIGIBLE', 'Kho được chọn không đủ toàn bộ nguyên liệu trong yêu cầu', {
          shortages,
        });
      }

      await conn.query(
        `UPDATE transfer_requests
            SET status = 'APPROVED', supplier_branch_id = ?, supplier_warehouse_id = ?,
                approved_by = ?, approved_at = NOW(3), version = version + 1
          WHERE id = ?`,
        [supplierBranchId, warehouseId, user.accountId, id],
      );
      const slipId = crypto.randomUUID();
      const slipCode = makeCode('PX');
      await conn.query(
        `INSERT INTO export_slips (id, code, request_id, branch_id, warehouse_id, status, version)
         VALUES (?, ?, ?, ?, ?, 'PENDING', 1)`,
        [slipId, slipCode, id, supplierBranchId, warehouseId],
      );
      await repo.writeAudit(conn, {
        transferId: id,
        action: 'APPROVED',
        from: 'PENDING_APPROVAL',
        to: 'APPROVED',
        user,
        requestId: ctx.requestId,
        details: { supplierBranchId, warehouseId, exportSlipCode: slipCode },
      });
      return { status: 200, body: { data: present(user, await repo.loadDetail(conn, id)) } };
    },
  );
}

async function rejectRequest(user, id, rawBody, expectedVersion, ctx) {
  const body = assertBody(rawBody, ['reason']);
  const reason = requiredString(body.reason, 'reason', { ...LIMITS.rejectionReason, code: 'REJECTION_REASON_REQUIRED' });
  return runIdempotent(
    { key: ctx.idempotencyKey, scope: `reject-transfer:${id}`, requestHash: hashRequest({ reason }) },
    async (conn) => {
      const row = await repo.lockRequest(conn, id);
      repo.assertStatus(row, ['PENDING_APPROVAL']);
      repo.assertVersion(row, expectedVersion);
      await conn.query(
        `UPDATE transfer_requests
            SET status = 'REJECTED', rejection_reason = ?, rejected_by = ?, rejected_at = NOW(3),
                version = version + 1
          WHERE id = ?`,
        [reason, user.accountId, id],
      );
      await repo.writeAudit(conn, {
        transferId: id,
        action: 'REJECTED',
        from: 'PENDING_APPROVAL',
        to: 'REJECTED',
        user,
        requestId: ctx.requestId,
        details: { reason },
      });
      return { status: 200, body: { data: present(user, await repo.loadDetail(conn, id)) } };
    },
  );
}

module.exports = {
  STATUSES,
  listRequests,
  getRequest,
  createRequest,
  updateRequest,
  deleteRequest,
  eligibleBranches,
  approveRequest,
  rejectRequest,
};
