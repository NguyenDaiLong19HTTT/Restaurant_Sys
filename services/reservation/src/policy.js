'use strict';

/**
 * Single source of truth for authorisation in reservation-service.
 *  1. PERMISSIONS: which roles may attempt an operation at all (checked by route middleware).
 *  2. Resource rules: branch scope + status + time (checked inside services, and exposed to the UI
 *     as `allowedActions` so buttons always match what the API will accept).
 * Customers are anonymous: only POST /reservations is public.
 */
const ROLES = Object.freeze({
  OWNER: 'CHU_CHUOI',
  MANAGER: 'QUAN_LY_CHI_NHANH',
  RECEPTION: 'NHAN_VIEN_TIEP_NHAN',
  WAITER: 'NHAN_VIEN_PHUC_VU',
});
const { RECEPTION } = ROLES;

// 00-QUY-UOC-CHUNG: confirming / updating / cancelling bookings belongs to reception staff.
const PERMISSIONS = Object.freeze({
  'reservation:read': [RECEPTION],
  'reservation:confirm': [RECEPTION],
  'reservation:update': [RECEPTION],
  'reservation:cancel': [RECEPTION],
  'table:read': [RECEPTION],
  'notification:read': [RECEPTION],
});

function can(user, permission) {
  return Boolean(user && PERMISSIONS[permission]?.includes(user.role));
}

// Reception staff see and act only on the branch in their token.
function inBranch(user, branchId) {
  return Boolean(user && user.branchId && user.branchId === branchId);
}

const isUpcoming = (row, now) => new Date(row.starts_at).getTime() > now;

// row = DB row of reservations
function reservationActions(user, row, now = Date.now()) {
  if (!inBranch(user, row.branch_id)) return [];
  const actions = [];
  if (row.status === 'PENDING' && isUpcoming(row, now)) {
    if (can(user, 'reservation:confirm')) actions.push('CONFIRM');
    if (can(user, 'reservation:update')) actions.push('EDIT');
    if (can(user, 'reservation:cancel')) actions.push('CANCEL');
  } else if (row.status === 'CONFIRMED' && isUpcoming(row, now)) {
    if (can(user, 'reservation:update')) actions.push('EDIT');
    if (can(user, 'reservation:cancel')) actions.push('CANCEL');
  } else if (row.status === 'CANCEL_PENDING' && can(user, 'reservation:cancel')) {
    // Order cancellation did not finish (dependency down): staff may retry, the worker also retries.
    actions.push('RETRY_CANCEL');
  }
  return actions;
}

module.exports = { ROLES, PERMISSIONS, can, inBranch, reservationActions };
