'use strict';

const crypto = require('node:crypto');
const { formatQuantity } = require('../lib/quantity');

// DP-261022-7K2QF (prefix-yymmdd-random)
function makeCode(prefix) {
  const now = new Date();
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(5, '0').slice(-5);
  return `${prefix}-${date}-${rand}`;
}

function mapIngredient(r) {
  return { id: r.id, code: r.code, name: r.name, unit: r.unit, description: r.description };
}

function mapWarehouse(r) {
  return { id: r.id, branchId: r.branch_id, code: r.code, name: r.name, status: r.status };
}

function mapRequest(r) {
  return {
    id: r.id,
    code: r.code,
    requesterBranchId: r.requester_branch_id,
    supplierBranchId: r.supplier_branch_id,
    supplierWarehouseId: r.supplier_warehouse_id,
    reason: r.reason,
    status: r.status,
    rejectionReason: r.rejection_reason,
    version: r.version,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    rejectedBy: r.rejected_by,
    rejectedAt: r.rejected_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapItem(r) {
  return {
    id: r.id,
    ingredientId: r.ingredient_id,
    ingredientCode: r.ingredient_code,
    ingredientName: r.ingredient_name,
    unit: r.unit,
    quantity: formatQuantity(r.quantity),
    note: r.note,
  };
}

function mapSlip(r) {
  return {
    id: r.id,
    code: r.code,
    requestId: r.request_id,
    requestCode: r.request_code,
    requestStatus: r.request_status,
    requestReason: r.request_reason,
    requesterBranchId: r.requester_branch_id,
    supplierBranchId: r.supplier_branch_id,
    branchId: r.branch_id,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name ?? null,
    status: r.status,
    version: r.version,
    confirmedBy: r.confirmed_by,
    confirmedAt: r.exported_at ?? r.imported_at ?? null,
    createdAt: r.created_at,
  };
}

function mapLine(r) {
  return {
    ingredientId: r.ingredient_id,
    ingredientName: r.ingredient_name,
    unit: r.unit,
    required: formatQuantity(r.required),
    available: formatQuantity(r.available),
    enough: Boolean(Number(r.enough)),
  };
}

module.exports = { makeCode, mapIngredient, mapWarehouse, mapRequest, mapItem, mapSlip, mapLine };
