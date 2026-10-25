'use strict';

const config = require('../config');
const logger = require('../logger');
const { conflict, unavailable } = require('../errors');

/**
 * Calls to order-service (03-HOP-DONG-API-NOI-BO):
 *   GET  /internal/v1/reservations/{id}/orders -> { orders: [{ id, status, cancellable }] }
 *   POST /internal/v1/orders/{id}/cancel        -> { id, status: CANCELLED } | 409 ORDER_LOCKED
 * A timeout is never treated as a definite failure: callers keep the booking CANCEL_PENDING and retry
 * with the same Idempotency-Key.
 */
async function request(method, path, { body, idempotencyKey, requestId }) {
  const headers = {
    Accept: 'application/json',
    'X-Request-Id': requestId,
    'X-Service-Token': config.internalServiceToken,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${config.orderBaseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      const payload = await res.json().catch(() => null);
      if (res.status === 409 && payload?.error?.code === 'ORDER_LOCKED') {
        throw conflict('ORDER_LOCKED', 'Order đi kèm đã được gửi chế biến, không thể hủy đơn đặt bàn', {
          orderId: payload.error.details?.orderId,
        });
      }
      if (!res.ok) throw new Error(`order-service HTTP ${res.status}`);
      return payload.data;
    } catch (err) {
      if (err.code === 'ORDER_LOCKED') throw err;
      lastError = err;
    }
  }
  logger.warn('order-service unavailable', { requestId, path, err: lastError.message });
  throw unavailable(
    'ORDER_SERVICE_UNAVAILABLE',
    'Chưa kiểm tra / hủy được order đi kèm. Đơn được giữ ở trạng thái "Đang hủy" và hệ thống sẽ tự thử lại',
  );
}

async function listOrders(reservationId, requestId) {
  const data = await request('GET', `/internal/v1/reservations/${encodeURIComponent(reservationId)}/orders`, {
    requestId,
  });
  const {pool}=require('../db');const [claims]=await pool.execute('SELECT order_id FROM reservation_order_claims WHERE reservation_id=?',[reservationId]);const rows=data?.orders??[];for(const c of claims)if(!rows.some(o=>o.id===c.order_id))throw unavailable('ORDER_CREATE_IN_PROGRESS','Order đang tạo; giữ đặt bàn để thử lại');return rows;
}

function cancelOrder(orderId, { reservationId, reason }, requestId) {
  return request('POST', `/internal/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
    body: { reservationId, reason },
    // Same key on every retry so the order is never cancelled twice.
    idempotencyKey: `reservation-cancel:${reservationId}:${orderId}`,
    requestId,
  });
}

module.exports = { listOrders, cancelOrder };
