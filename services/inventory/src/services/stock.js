'use strict';

const { pool } = require('../db');
const { notFound } = require('../errors');
const { parsePaging } = require('../lib/http');
const { formatQuantity } = require('../lib/quantity');
const { optionalId } = require('../lib/validate');
const { getBranch } = require('../lib/branchClient');
const { assertBranchScope } = require('../middleware/auth');
const { mapIngredient, mapWarehouse } = require('./mappers');

async function listIngredients(query) {
  const { page, limit, offset } = parsePaging(query);
  const params = [];
  let where = '';
  if (query.q) {
    const q = String(query.q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`);
    where = 'WHERE name LIKE ? OR code LIKE ?';
    params.push(`%${q}%`, `%${q}%`);
  }
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ingredients ${where}`, params);
  const [rows] = await pool.query(`SELECT * FROM ingredients ${where} ORDER BY name LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return { data: rows.map(mapIngredient), meta: { page, limit, total: Number(total) } };
}

// A branch with no warehouse may simply not exist: ask branch-service, but don't fail reads if it is down.
async function assertBranchKnown(branchId, requestId) {
  try {
    if (!(await getBranch(branchId, requestId))) {
      throw notFound('BRANCH_NOT_FOUND', 'Chi nhánh không tồn tại', { branchId });
    }
  } catch (err) {
    if (err.code !== 'BRANCH_SERVICE_UNAVAILABLE') throw err;
  }
}

async function getBranchStock(user, branchId, query, ctx) {
  assertBranchScope(user, branchId);
  const warehouseId = optionalId(query.warehouseId, 'warehouseId');
  const [warehouses] = await pool.query('SELECT * FROM warehouses WHERE branch_id = ? ORDER BY created_at, id', [
    branchId,
  ]);
  if (!warehouses.length) await assertBranchKnown(branchId, ctx.requestId);
  let selected = warehouses;
  if (warehouseId) {
    selected = warehouses.filter((w) => w.id === warehouseId);
    if (!selected.length) throw notFound('WAREHOUSE_NOT_FOUND', 'Kho không thuộc chi nhánh này');
  }

  let balances = [];
  if (selected.length) {
    // Every ingredient appears for every warehouse, zero when there is no balance row yet.
    const [rows] = await pool.query(
      `SELECT w.id AS warehouse_id, i.id AS ingredient_id, i.code, i.name, i.unit,
              COALESCE(sb.quantity, 0) AS quantity, sb.updated_at
         FROM warehouses w
         CROSS JOIN ingredients i
         LEFT JOIN stock_balances sb ON sb.warehouse_id = w.id AND sb.ingredient_id = i.id
        WHERE w.id IN (?)
        ORDER BY w.created_at, w.id, i.name`,
      [selected.map((w) => w.id)],
    );
    balances = rows.map((r) => ({
      warehouseId: r.warehouse_id,
      ingredientId: r.ingredient_id,
      ingredientCode: r.code,
      ingredientName: r.name,
      unit: r.unit,
      quantity: formatQuantity(r.quantity),
      updatedAt: r.updated_at,
    }));
  }
  return { branchId, warehouses: warehouses.map(mapWarehouse), balances };
}

async function listMovements(user, branchId, query) {
  assertBranchScope(user, branchId);
  const { page, limit, offset } = parsePaging(query);
  const warehouseId = optionalId(query.warehouseId, 'warehouseId');
  const params = [branchId];
  let where = 'WHERE w.branch_id = ?';
  if (warehouseId) {
    where += ' AND m.warehouse_id = ?';
    params.push(warehouseId);
  }
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id ${where}`,
    params,
  );
  const [rows] = await pool.query(
    `SELECT m.*, w.name AS warehouse_name, i.code AS ingredient_code, i.name AS ingredient_name, i.unit,
            COALESCE(es.code, isl.code) AS source_code
       FROM stock_movements m
       JOIN warehouses w ON w.id = m.warehouse_id
       JOIN ingredients i ON i.id = m.ingredient_id
       LEFT JOIN export_slips es ON m.source_type = 'EXPORT_SLIP' AND es.id = m.source_id
       LEFT JOIN import_slips isl ON m.source_type = 'IMPORT_SLIP' AND isl.id = m.source_id
      ${where}
      ORDER BY m.created_at DESC, m.id
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return {
    data: rows.map((r) => ({
      id: r.id,
      warehouseId: r.warehouse_id,
      warehouseName: r.warehouse_name,
      ingredientId: r.ingredient_id,
      ingredientCode: r.ingredient_code,
      ingredientName: r.ingredient_name,
      unit: r.unit,
      quantityDelta: formatQuantity(r.quantity_delta),
      balanceAfter: formatQuantity(r.balance_after),
      sourceType: r.source_type,
      sourceId: r.source_id,
      sourceCode: r.source_code,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
    meta: { page, limit, total: Number(total) },
  };
}

module.exports = { listIngredients, getBranchStock, listMovements };
