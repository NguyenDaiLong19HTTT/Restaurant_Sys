'use strict';

/**
 * Single source of truth for authorisation in inventory-service.
 *  1. PERMISSIONS: which roles may attempt an operation at all (checked by route middleware).
 *  2. Resource rules: branch scope + current status (checked inside services, and exposed to the UI
 *     as `allowedActions` so buttons always match what the API will accept).
 */
const ROLES = Object.freeze({
  OWNER: 'CHU_CHUOI',
  MANAGER: 'QUAN_LY_CHI_NHANH',
  RECEPTION: 'NHAN_VIEN_TIEP_NHAN',
  WAITER: 'NHAN_VIEN_PHUC_VU',
});
const { OWNER, MANAGER } = ROLES;

const PERMISSIONS = Object.freeze({
  'ingredient:read': [OWNER, MANAGER],
  'stock:read': [OWNER, MANAGER],
  'transfer:read': [OWNER, MANAGER],
  'transfer:create': [MANAGER],
  'transfer:update': [MANAGER],
  'transfer:delete': [MANAGER],
  'transfer:approve': [OWNER],
  'transfer:reject': [OWNER],
  'slip:read': [OWNER, MANAGER],
  'export:confirm': [MANAGER],
  'import:confirm': [MANAGER],
});

function can(user, permission) {
  return Boolean(user && PERMISSIONS[permission]?.includes(user.role));
}

// Owner: every branch. Manager: only the branch in their token.
function canAccessBranch(user, branchId) {
  return user.role === OWNER || (user.role === MANAGER && user.branchId === branchId);
}

// row = DB row of transfer_requests
function canViewTransfer(user, row) {
  if (!can(user, 'transfer:read')) return false;
  return (
    user.role === OWNER ||
    (user.role === MANAGER && (user.branchId === row.requester_branch_id || user.branchId === row.supplier_branch_id))
  );
}

function isRequesterManager(user, row) {
  return user.role === MANAGER && user.branchId === row.requester_branch_id;
}

function transferActions(user, row) {
  const actions = [];
  if (row.status !== 'PENDING_APPROVAL') return actions;
  if (can(user, 'transfer:update') && isRequesterManager(user, row)) actions.push('EDIT');
  if (can(user, 'transfer:delete') && isRequesterManager(user, row)) actions.push('DELETE');
  if (can(user, 'transfer:approve')) actions.push('APPROVE');
  if (can(user, 'transfer:reject')) actions.push('REJECT');
  return actions;
}

// row = DB row of export_slips / import_slips (joined with transfer_requests.status as request_status)
function slipActions(user, kind, row) {
  const permission = kind === 'export' ? 'export:confirm' : 'import:confirm';
  const expectedRequestStatus = kind === 'export' ? 'APPROVED' : 'EXPORTED';
  const ok =
    row.status === 'PENDING' &&
    (row.request_status === undefined || row.request_status === expectedRequestStatus) &&
    can(user, permission) &&
    user.branchId === row.branch_id;
  return ok ? ['CONFIRM'] : [];
}

module.exports = {
  ROLES,
  PERMISSIONS,
  can,
  canAccessBranch,
  canViewTransfer,
  isRequesterManager,
  transferActions,
  slipActions,
};
