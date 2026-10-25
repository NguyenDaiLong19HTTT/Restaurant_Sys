'use strict';

const config = require('../config');
const HttpError = require('../domain/http-error');
const { requestJson } = require('./http-client');

async function validateDineIn({ serviceType, branchId, tableId, reservationId, requestId }) {
  if (serviceType !== 'DINE_IN') return;
  if (!tableId && !reservationId) throw new HttpError(422, 'TABLE_OR_RESERVATION_REQUIRED', 'DINE_IN orders require a tableId or reservationId');
  let reservation = null;
  if (reservationId) {
    reservation = await requestJson(config.reservationBaseUrl, `/internal/v1/reservations/${encodeURIComponent(reservationId)}/order-context`, { method: 'GET', requestId });
    if (reservation.status !== 'CONFIRMED') throw new HttpError(422, 'INVALID_RESERVATION_STATE', 'Reservation must be CONFIRMED to create a DINE_IN order');
    if (reservation.branchId !== branchId) throw new HttpError(422, 'BRANCH_MISMATCH', 'Reservation belongs to a different branch');
    if (tableId && reservation.tableId !== tableId) throw new HttpError(422, 'TABLE_MISMATCH', 'Table does not match the reservation');
  }
  const resolvedTableId = tableId || reservation?.tableId;
  if (resolvedTableId) {
    const table = await requestJson(config.reservationBaseUrl, `/internal/v1/tables/${encodeURIComponent(resolvedTableId)}/order-context`, { method: 'GET', requestId });
    if (table.branchId !== branchId) throw new HttpError(422, 'BRANCH_MISMATCH', 'Table belongs to a different branch');
    if (table.status !== 'ACTIVE') throw new HttpError(422, 'TABLE_UNAVAILABLE', 'Table is not active');
  }
  return resolvedTableId;
}

module.exports = { validateDineIn };
