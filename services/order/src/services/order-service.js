'use strict';

const crypto = require('node:crypto');
const repository = require('../repositories/order-repository');
const { resolveDishes } = require('../integrations/menu-client');
const { validateDineIn } = require('../integrations/reservation-client');
const HttpError = require('../domain/http-error');
const { positiveInteger } = require('../domain/validation');

function assertVersion(order, expectedVersion, { allowSubmitted = false } = {}) {
  if (Number(order.version) !== expectedVersion) throw new HttpError(409, 'VERSION_CONFLICT', 'Order was changed by another request', { currentVersion: Number(order.version) });
  const allowedStatus = order.status === 'DRAFT' || (allowSubmitted && order.status === 'SUBMITTED');
  if (order.payment_lock_id || order.payment_status === 'PAID' || !allowedStatus) throw new HttpError(409, 'ORDER_LOCKED', 'Only unpaid DRAFT orders can be changed; submitted orders only accept additional items');
}

async function idempotent(scope, key, body, operation) {
  const hash = repository.requestHash(body);
  try {
    return await repository.withTransaction(async (connection) => {
      const record = await repository.addIdempotencyRecord(connection, { scope, key, requestHash: hash });
      if (record.replay) return { replay: true, status: record.status, body: record.body };
      const result = await operation(connection);
      await repository.saveIdempotentResponse(connection, { scope, key, status: result.status, body: result.body });
      return { replay: false, ...result };
    });
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    const [rows] = await repository.pool.execute('SELECT request_hash, response_status, response_body FROM idempotency_records WHERE scope = ? AND idempotency_key = ?', [scope, key]);
    if (rows[0]?.request_hash === hash && rows[0]?.response_status && rows[0]?.response_body) {
      return { replay: true, status: rows[0].response_status, body: rows[0].response_body };
    }
    throw new HttpError(409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is already in progress');
  }
}

async function create({ user, body, requestId, key, branchId }) {
  const { serviceType, tableId: requestedTableId = null, reservationId = null, items, recipientName = null, recipientPhone = null } = body;
  let tableId=requestedTableId;
  if (!branchId) throw new HttpError(422, 'BRANCH_REQUIRED', 'branchId is required');
  if (!['DINE_IN', 'TAKEAWAY'].includes(serviceType)) throw new HttpError(422, 'INVALID_SERVICE_TYPE', 'serviceType must be DINE_IN or TAKEAWAY');
  if (serviceType === 'TAKEAWAY' && (tableId || reservationId)) throw new HttpError(422, 'INVALID_ORDER_CONTEXT', 'TAKEAWAY orders cannot include tableId or reservationId');
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new HttpError(422, 'INVALID_ITEMS', 'Order must contain between 1 and 100 items');
  const normalized = items.map((item) => ({ dishId: String(item.dishId || ''), quantity: positiveInteger(item.quantity, 'quantity', 10000) }));
  if (normalized.some((item) => !item.dishId)) throw new HttpError(422, 'VALIDATION_ERROR', 'Each item requires a dishId');

  const dishIds = [...new Set(normalized.map((item) => item.dishId))];
  const dishes = await resolveDishes(dishIds, requestId);
  tableId=await validateDineIn({ serviceType, branchId, tableId, reservationId, requestId })||tableId;
  const scope = `${user.accountId}:POST:/orders`;
  return idempotent(scope, key, body, async (connection) => {
    const raw=crypto.createHash('sha256').update(scope+':'+key).digest('hex');const id=raw.slice(0,8)+'-'+raw.slice(8,12)+'-4'+raw.slice(13,16)+'-8'+raw.slice(17,20)+'-'+raw.slice(20,32);
    if(reservationId)await require('../integrations/http-client').requestJson(require('../config').reservationBaseUrl,'/internal/v1/reservations/'+encodeURIComponent(reservationId)+'/order-claims',{method:'POST',body:JSON.stringify({orderId:id,tableId,branchId}),requestId});
    const code = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await connection.execute('INSERT INTO orders (id, code, branch_id, reservation_id, table_id, service_type, status, created_by) VALUES (?, ?, ?, ?, ?, ?, \'DRAFT\', ?)', [id, code, branchId, reservationId, tableId, serviceType, user.accountId]);
    for (const item of normalized) {
      const dish = dishes.get(item.dishId);
      const price = Number(dish.priceVnd);
      const total = price * item.quantity;
      if (!Number.isSafeInteger(total)) throw new HttpError(422, 'AMOUNT_TOO_LARGE', 'Line total exceeds supported amount');
      await connection.execute('INSERT INTO order_items (id, order_id, dish_id, dish_name_snapshot, unit_price_vnd, quantity, line_total_vnd) VALUES (?, ?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), id, item.dishId, dish.name, price, item.quantity, total]);
    }
    if (serviceType === 'TAKEAWAY' && (recipientName || recipientPhone)) {
      await connection.execute('INSERT INTO takeaway_details (order_id, recipient_name, recipient_phone) VALUES (?, ?, ?)', [id, recipientName, recipientPhone]);
    }
    await repository.updateTotal(connection, id);
    return { status: 201, body: { data: await repository.getDetail(id, connection) } };
  });
}

async function mutateDraft({ id, user, version, mutate, allowSubmitted = false }) {
  return repository.withTransaction(async (connection) => {
    const order = await repository.findScoped(id, user, { lock: true, connection });
    assertVersion(order, version, { allowSubmitted });
    await mutate(connection, order);
    await repository.updateTotal(connection, id);
    await connection.execute('UPDATE orders SET version = version + 1 WHERE id = ?', [id]);
    return repository.getDetail(id, connection);
  });
}

async function addItem({ id, user, version, body, requestId }) {
  const dishId = String(body.dishId || '');
  if (!dishId) throw new HttpError(422, 'VALIDATION_ERROR', 'dishId is required');
  const quantity = positiveInteger(body.quantity, 'quantity', 10000);
  const dishes = await resolveDishes([dishId], requestId);
  const dish = dishes.get(dishId);
  const lineTotal = Number(dish.priceVnd) * quantity;
  if (!Number.isSafeInteger(lineTotal)) throw new HttpError(422, 'AMOUNT_TOO_LARGE', 'Line total exceeds supported amount');
  return mutateDraft({ id, user, version, allowSubmitted: true, mutate: async (connection, order) => {
    const [existingRows] = await connection.execute('SELECT * FROM order_items WHERE order_id = ? AND dish_id = ? FOR UPDATE', [order.id, dishId]);
    const existing = existingRows[0];
    if (existing) {
      const nextQuantity = Number(existing.quantity) + quantity;
      if (nextQuantity > 10000) throw new HttpError(422, 'QUANTITY_TOO_LARGE', 'Item quantity cannot exceed 10000');
      const nextTotal = Number(existing.unit_price_vnd) * nextQuantity;
      if (!Number.isSafeInteger(nextTotal)) throw new HttpError(422, 'AMOUNT_TOO_LARGE', 'Line total exceeds supported amount');
      await connection.execute('UPDATE order_items SET quantity = ?, line_total_vnd = ? WHERE id = ?', [nextQuantity, nextTotal, existing.id]);
    } else {
      await connection.execute('INSERT INTO order_items (id, order_id, dish_id, dish_name_snapshot, unit_price_vnd, quantity, line_total_vnd) VALUES (?, ?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), order.id, dishId, dish.name, Number(dish.priceVnd), quantity, lineTotal]);
    }
  } });
}

async function updateItem({ id, itemId, user, version, quantity }) {
  return mutateDraft({ id, user, version, mutate: async (connection, order) => {
    const [items] = await connection.execute('SELECT * FROM order_items WHERE id = ? AND order_id = ?', [itemId, order.id]);
    if (!items.length) throw new HttpError(404, 'ORDER_ITEM_NOT_FOUND', 'Order item was not found');
    const total = Number(items[0].unit_price_vnd) * quantity;
    if (!Number.isSafeInteger(total)) throw new HttpError(422, 'AMOUNT_TOO_LARGE', 'Line total exceeds supported amount');
    await connection.execute('UPDATE order_items SET quantity = ?, line_total_vnd = ? WHERE id = ?', [quantity, total, itemId]);
  } });
}

async function removeItem({ id, itemId, user, version }) {
  return mutateDraft({ id, user, version, mutate: async (connection, order) => {
    const [items] = await connection.execute('SELECT id FROM order_items WHERE order_id = ? FOR UPDATE', [order.id]);
    if (!items.some((item) => item.id === itemId)) throw new HttpError(404, 'ORDER_ITEM_NOT_FOUND', 'Order item was not found');
    await connection.execute('DELETE FROM order_items WHERE id = ?', [itemId]);
  } });
}

async function submit({ id, user, version, key, body }) {
  return idempotent(`${user.accountId}:POST:/orders/${id}/submit`, key, body, async (connection) => {
    const order = await repository.findScoped(id, user, { lock: true, connection });
    if (Number(order.version) !== version) throw new HttpError(409, 'VERSION_CONFLICT', 'Order was changed by another request', { currentVersion: Number(order.version) });
    if (order.status !== 'DRAFT') throw new HttpError(409, 'ORDER_LOCKED', 'Only DRAFT orders can be submitted');
    const [[items]] = await connection.execute('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?', [id]);
    if (Number(items.count) < 1) throw new HttpError(422, 'ORDER_MUST_HAVE_ITEM', 'Add at least one item before submitting the order');
    await connection.execute('UPDATE orders SET status = \'SUBMITTED\', version = version + 1 WHERE id = ?', [id]);
    return { status: 200, body: { data: await repository.getDetail(id, connection) } };
  });
}

async function handover({ id, user, version, key, body }) {
  return idempotent(`${user.accountId}:POST:/orders/${id}/handover`, key, body, async (connection) => {
    const order = await repository.findScoped(id, user, { lock: true, connection });
    if (order.service_type !== 'TAKEAWAY') throw new HttpError(422, 'ORDER_NOT_TAKEAWAY', 'Only TAKEAWAY orders can be handed over');
    if (order.payment_lock_id || order.status !== 'SUBMITTED') throw new HttpError(409, 'INVALID_ORDER_STATE', 'Only submitted TAKEAWAY orders can be handed over');
    if (Number(order.version) !== version) throw new HttpError(409, 'VERSION_CONFLICT', 'Order was changed by another request', { currentVersion: Number(order.version) });
    await connection.execute('UPDATE orders SET status = \'HANDED_OVER\', version = version + 1 WHERE id = ?', [id]);
    await connection.execute('INSERT INTO takeaway_details (order_id, handover_at) VALUES (?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE handover_at = VALUES(handover_at)', [id]);
    return { status: 200, body: { data: await repository.getDetail(id, connection) } };
  });
}

async function cancelFromReservation({ id, reservationId, key, body }) {
  const scope = `internal:${id}:cancel`;
  return idempotent(scope, key, body, async (connection) => {
    const order = await repository.findScoped(id, { role: 'CHU_CHUOI', branchId: null }, { lock: true, connection });
    if (order.reservation_id !== reservationId) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order was not found for this reservation');
    if (order.status !== 'DRAFT' && order.status !== 'CANCELLED') throw new HttpError(409, 'ORDER_LOCKED', 'Submitted orders cannot be cancelled');
    if (order.status === 'DRAFT') await connection.execute('UPDATE orders SET status = \'CANCELLED\', version = version + 1 WHERE id = ?', [id]);
    return { status: 200, body: { data: { id, status: 'CANCELLED' } } };
  });
}

module.exports = {
  create, mutateDraft, addItem, updateItem, removeItem,
  submit, handover, cancelFromReservation, assertVersion
};
