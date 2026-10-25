'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../logger');
const { pool, withTransaction } = require('../db');
const { badRequest, conflict, notFound, unprocessable } = require('../errors');
const { parsePaging } = require('../lib/http');
const { runIdempotent, hashRequest } = require('../lib/idempotency');
const { assertAcceptsReservations } = require('../lib/branchClient');
const orderClient = require('../lib/orderClient');
const { parseStartsAt, addMinutes, assertBookingTime, localDayRange } = require('../lib/time');
const v = require('../lib/validate');
const { assertBranchScope } = require('../middleware/auth');
const { reservationActions } = require('../policy');
const { makeCode, mapReservation, mapPublicReservation } = require('./mappers');
const notifications = require('./notifications');
const repo = require('./repo');

const PUBLIC_ACTOR = { accountId: 'public', role: 'KHACH_HANG', branchId: null };
const SYSTEM_ACTOR = { accountId: 'system', role: 'SYSTEM', branchId: null };

const present = (user, row, history) => ({
  ...mapReservation(row),
  allowedActions: reservationActions(user, row),
  ...(history ? { history } : {}),
});

// Data for the outbox templates; row comes from repo.loadReservation.
const notice = (row, extra = {}) => ({
  id: row.id,
  code: row.code,
  branchId: row.branch_id,
  phone: row.customer_phone,
  startsAt: new Date(row.starts_at),
  partySize: row.party_size,
  tableName: row.table_name,
  ...extra,
});

const isPast = (row) => new Date(row.starts_at).getTime() <= Date.now();

// One booking uses one table (00-QUY-UOC-CHUNG E.1), so a party larger than every table cannot be served.
async function assertPartyFits(conn, branchId, party) {
  const cap = await repo.maxCapacity(conn, branchId);
  if (cap === 0) throw unprocessable('NO_TABLES', 'Chi nhánh chưa có bàn nhận đặt trước', { field: 'branchId' });
  if (party > cap) {
    throw unprocessable(
      'PARTY_TOO_LARGE',
      `Bàn lớn nhất của chi nhánh có ${cap} chỗ. Với nhóm đông hơn, vui lòng gọi điện cho nhà hàng`,
      { field: 'partySize', maxCapacity: cap },
    );
  }
}

async function preCheck(user, id) {
  const [[row]] = await pool.query('SELECT branch_id FROM reservations WHERE id = ?', [id]);
  if (!row) throw notFound('RESERVATION_NOT_FOUND', 'Không tìm thấy đơn đặt bàn');
  // Checked before any idempotent section so a replay never leaks another branch's data.
  assertBranchScope(user, row.branch_id);
}

// ---------- UC01: customer submits the public form ------------------------------------------
async function createPublic(rawBody, ctx) {
  const body = v.assertBody(rawBody, ['branchId', 'customerName', 'phone', 'startsAt', 'partySize', 'serviceType']);
  const branchId = v.requiredId(body.branchId, 'branchId');
  const fullName = v.customerName(body.customerName);
  const phone = v.normalizePhone(body.phone);
  const startsAt = parseStartsAt(body.startsAt);
  const party = v.partySize(body.partySize, config.booking.maxPartySize);
  const serviceType = v.serviceType(body.serviceType);
  assertBookingTime(startsAt, config.booking);
  await assertAcceptsReservations(branchId, ctx.requestId);

  const id = crypto.randomUUID();
  const endsAt = addMinutes(startsAt, config.booking.durationMinutes);
  return runIdempotent(
    {
      key: ctx.idempotencyKey,
      scope: 'public-create-reservation',
      requestHash: hashRequest({ branchId, fullName, phone, startsAt, party, serviceType }),
    },
    async (conn) => {
      await assertPartyFits(conn, branchId, party);
      const customerId = await repo.findOrCreateCustomer(conn, fullName, phone);
      // BR005/BR006: unique code, status PENDING, no table yet.
      await conn.query(
        `INSERT INTO reservations
           (id, code, customer_id, branch_id, starts_at, ends_at, party_size, service_type, status, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1)`,
        [id, makeCode('DB'), customerId, branchId, startsAt, endsAt, party, serviceType],
      );
      await repo.writeAudit(conn, {
        reservationId: id,
        action: 'CREATED',
        to: 'PENDING',
        user: PUBLIC_ACTOR,
        requestId: ctx.requestId,
        details: { partySize: party, serviceType },
      });
      const row = await repo.loadReservation(conn, id);
      // BR007: notify the customer and the branch's reception staff.
      await notifications.enqueue(conn, 'CREATED', notice(row));
      logger.info('reservation created', { requestId: ctx.requestId, reservationId: id, branchId, phone: v.maskPhone(phone) });
      return { status: 201, body: { data: mapPublicReservation(row) } };
    },
  );
}

// ---------- Reception: list / detail ---------------------------------------------------------
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function listReservations(user, query) {
  const { page, limit, offset } = parsePaging(query);
  const status = v.oneOf(query.status, v.STATUSES, 'status');
  const when = v.oneOf(query.when, ['upcoming', 'past'], 'when');
  // The branch always comes from the token; asking for another branch is refused, not ignored.
  const branchId = v.optionalId(query.branchId, 'branchId') ?? user.branchId;
  assertBranchScope(user, branchId);

  const where = ['r.branch_id = ?'];
  const params = [branchId];
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (query.date) {
    const { from, to } = localDayRange(String(query.date));
    where.push('r.starts_at >= ? AND r.starts_at < ?');
    params.push(from, to);
  }
  if (when === 'upcoming') where.push('r.ends_at > NOW(3)');
  if (when === 'past') where.push('r.ends_at <= NOW(3)');

  // UC02/UC03 look a booking up by its code; phone and name help when the customer forgot the code.
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 50) : '';
  if (q) {
    const like = `%${escapeLike(q)}%`;
    const conditions = ['r.code LIKE ?', 'c.full_name LIKE ?'];
    params.push(like, like);
    let digits = q.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('84')) digits = `0${digits.slice(2)}`;
    if (digits.length >= 3) {
      conditions.push('c.phone LIKE ?');
      params.push(`%${digits}%`);
    }
    where.push(`(${conditions.join(' OR ')})`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const order = when === 'past' || status === 'CANCELLED' ? 'DESC' : 'ASC';

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM reservations r JOIN customers c ON c.id = r.customer_id ${whereSql}`,
    params,
  );
  const [rows] = await pool.query(`${repo.RES_SELECT} ${whereSql} ORDER BY r.starts_at ${order}, r.id LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return { data: rows.map((r) => present(user, r)), meta: { page, limit, total: Number(total) } };
}

async function getReservation(user, id) {
  const row = await repo.loadReservation(pool, id);
  if (!row) throw notFound('RESERVATION_NOT_FOUND', 'Không tìm thấy đơn đặt bàn');
  assertBranchScope(user, row.branch_id);
  return present(user, row, await repo.loadHistory(pool, id));
}

// ---------- UC04: confirm and assign a table ------------------------------------------------
async function confirmReservation(user, id, rawBody, expectedVersion, ctx) {
  const body = v.assertBody(rawBody, ['tableId']);
  const tableId = v.requiredId(body.tableId, 'tableId');
  await preCheck(user, id);

  return runIdempotent(
    { key: ctx.idempotencyKey, scope: `confirm-reservation:${id}`, requestHash: hashRequest({ tableId }) },
    async (conn) => {
      const res = await repo.lockReservation(conn, id);
      repo.assertStatus(res, ['PENDING']);
      repo.assertVersion(res, expectedVersion);
      if (isPast(res)) throw unprocessable('RESERVATION_EXPIRED', 'Đơn đã quá giờ đặt, không thể xác nhận');

      // BR011: lock the table row, then re-check its schedule. Every path that assigns a table takes
      // this same lock, so two confirmations for overlapping slots run one after the other.
      const table = await repo.lockTable(conn, tableId);
      if (!table || table.branch_id !== res.branch_id) {
        throw unprocessable('TABLE_NOT_IN_BRANCH', 'Bàn được chọn không thuộc chi nhánh của đơn', { tableId });
      }
      if (table.status !== 'ACTIVE') throw unprocessable('TABLE_INACTIVE', 'Bàn đang ngừng sử dụng', { tableId });
      if (table.capacity < res.party_size) {
        throw unprocessable('TABLE_TOO_SMALL', `Bàn ${table.name} chỉ có ${table.capacity} chỗ, đơn có ${res.party_size} khách`, {
          tableId,
        });
      }
      const conflicts = await repo.findConflicts(conn, tableId, res.starts_at, res.ends_at, id);
      if (conflicts.length) {
        throw conflict('TABLE_TIME_CONFLICT', 'Bàn đã được đặt bởi khách khác trong khoảng thời gian này', {
          tableId,
          conflicts: conflicts.map((c) => ({ reservationCode: c.code, startsAt: c.starts_at, endsAt: c.ends_at })),
        });
      }

      await conn.query(
        `UPDATE reservations SET status = 'CONFIRMED', table_id = ?, confirmed_by = ?, confirmed_at = NOW(3),
                version = version + 1
          WHERE id = ?`,
        [tableId, user.accountId, id],
      );
      await repo.writeAudit(conn, {
        reservationId: id,
        action: 'CONFIRMED',
        from: 'PENDING',
        to: 'CONFIRMED',
        user,
        requestId: ctx.requestId,
        details: { tableId, tableCode: table.code },
      });
      const row = await repo.loadReservation(conn, id);
      await notifications.enqueue(conn, 'CONFIRMED', notice(row));
      return { status: 200, body: { data: present(user, row) } };
    },
  );
}

// ---------- UC03: update details -------------------------------------------------------------
/**
 * BR018: keep the assigned table when it still fits the new time / party size, otherwise move the
 * booking to the smallest free suitable table of the same branch. All candidates are locked in one
 * fixed order (capacity, code) like everywhere else, so concurrent updates cannot double-book.
 */
async function pickTable(conn, res, { startsAt, endsAt, party }) {
  const candidates = await repo.lockSuitableTables(conn, res.branch_id, party);
  const ordered = [
    ...candidates.filter((t) => t.id === res.table_id),
    ...candidates.filter((t) => t.id !== res.table_id),
  ];
  for (const table of ordered) {
    const conflicts = await repo.findConflicts(conn, table.id, startsAt, endsAt, res.id);
    if (!conflicts.length) return table;
  }
  throw conflict('NO_TABLE_AVAILABLE', 'Không còn bàn phù hợp với thời gian và số khách mới; đơn được giữ nguyên', {
    partySize: party,
    startsAt,
  });
}

async function updateReservation(user, id, rawBody, expectedVersion, ctx) {
  // BR014: only date/time, party size, name and phone; never code, branch or status.
  const body = v.assertBody(rawBody, ['customerName', 'phone', 'startsAt', 'partySize']);
  if (!Object.keys(body).length) {
    throw badRequest('VALIDATION_ERROR', 'Cần gửi ít nhất một trường: customerName, phone, startsAt, partySize');
  }
  const next = {
    fullName: body.customerName !== undefined ? v.customerName(body.customerName) : undefined,
    phone: body.phone !== undefined ? v.normalizePhone(body.phone) : undefined,
    startsAt: body.startsAt !== undefined ? parseStartsAt(body.startsAt) : undefined,
    partySize: body.partySize !== undefined ? v.partySize(body.partySize, config.booking.maxPartySize) : undefined,
  };
  await preCheck(user, id);

  return withTransaction(async (conn) => {
    const res = await repo.lockReservation(conn, id);
    repo.assertStatus(res, ['PENDING', 'CONFIRMED'], 'RESERVATION_NOT_EDITABLE');
    repo.assertVersion(res, expectedVersion);
    if (isPast(res)) throw unprocessable('RESERVATION_STARTED', 'Đơn đã đến giờ phục vụ, không thể cập nhật');

    const [[customer]] = await conn.query('SELECT full_name, phone FROM customers WHERE id = ?', [res.customer_id]);
    const oldStart = new Date(res.starts_at);
    const fullName = next.fullName ?? customer.full_name;
    const phone = next.phone ?? customer.phone;
    const startsAt = next.startsAt ?? oldStart;
    const party = next.partySize ?? res.party_size;

    const changes = {};
    if (fullName !== customer.full_name) changes.customerName = { from: customer.full_name, to: fullName };
    if (phone !== customer.phone) changes.phone = { from: v.maskPhone(customer.phone), to: v.maskPhone(phone) };
    if (startsAt.getTime() !== oldStart.getTime()) changes.startsAt = { from: oldStart, to: startsAt };
    if (party !== res.party_size) changes.partySize = { from: res.party_size, to: party };
    if (!Object.keys(changes).length) {
      throw unprocessable('NO_CHANGES', 'Thông tin không có thay đổi nào so với đơn hiện tại');
    }
    if (changes.startsAt) assertBookingTime(startsAt, config.booking);
    if (changes.partySize) await assertPartyFits(conn, res.branch_id, party);

    // The booked duration is kept when the start time moves.
    const endsAt = addMinutes(startsAt, (new Date(res.ends_at).getTime() - oldStart.getTime()) / 60000);
    let tableId = res.table_id;
    let tableChange = null;
    if (res.status === 'CONFIRMED' && (changes.startsAt || changes.partySize)) {
      const [[oldTable]] = await conn.query('SELECT id, code, name FROM tables WHERE id = ?', [res.table_id]);
      const table = await pickTable(conn, res, { startsAt, endsAt, party });
      tableId = table.id;
      if (table.id !== res.table_id) {
        tableChange = { from: { id: oldTable.id, code: oldTable.code, name: oldTable.name }, to: { id: table.id, code: table.code, name: table.name } };
      }
    }
    const customerId =
      changes.customerName || changes.phone ? await repo.findOrCreateCustomer(conn, fullName, phone) : res.customer_id;

    await conn.query(
      `UPDATE reservations SET customer_id = ?, starts_at = ?, ends_at = ?, party_size = ?, table_id = ?,
              version = version + 1
        WHERE id = ?`,
      [customerId, startsAt, endsAt, party, tableId, id],
    );
    await repo.writeAudit(conn, {
      reservationId: id,
      action: 'UPDATED',
      from: res.status,
      to: res.status,
      user,
      requestId: ctx.requestId,
      details: { changes, tableChange },
    });
    const row = await repo.loadReservation(conn, id);
    // BR020: message goes to the phone number now on the booking.
    await notifications.enqueue(conn, 'UPDATED', notice(row));
    return { data: present(user, row), meta: { tableChanged: Boolean(tableChange), tableChange } };
  });
}

// ---------- UC02: cancel --------------------------------------------------------------------
const lockedOrder = (orders) => orders.find((o) => o.status !== 'CANCELLED' && !o.cancellable);

/**
 * CANCEL_PENDING -> CANCELLED: cancel every DRAFT order of the booking (same Idempotency-Key on each retry),
 * then release the table. Any failure leaves the booking CANCEL_PENDING; the worker retries later.
 */
async function finishCancellation(id, actor, requestId) {
  const [[row]] = await pool.query('SELECT status, cancel_reason FROM reservations WHERE id = ?', [id]);
  if (row?.status === 'CANCEL_PENDING') {
    const orders = await orderClient.listOrders(id, requestId);
    const locked = lockedOrder(orders);
    if (locked) {
      throw conflict('ORDER_LOCKED', 'Order đi kèm đã được gửi chế biến, không thể hủy đơn đặt bàn', {
        orderId: locked.id,
        orderStatus: locked.status,
      });
    }
    const cancelled = [];
    for (const order of orders.filter((o) => o.status === 'DRAFT')) {
      await orderClient.cancelOrder(order.id, { reservationId: id, reason: row.cancel_reason }, requestId);
      cancelled.push(order.id);
    }

    await withTransaction(async (conn) => {
      const res = await repo.lockReservation(conn, id);
      if (res.status !== 'CANCEL_PENDING') return;
      await conn.query(
        "UPDATE reservations SET status = 'CANCELLED', cancelled_at = NOW(3), version = version + 1 WHERE id = ?",
        [id],
      );
      await repo.writeAudit(conn, {
        reservationId: id,
        action: 'CANCELLED',
        from: 'CANCEL_PENDING',
        to: 'CANCELLED',
        user: actor,
        requestId,
        details: { cancelledOrderIds: cancelled },
      });
      const fresh = await repo.loadReservation(conn, id);
      await notifications.enqueue(conn, 'CANCELLED', notice(fresh, { reason: fresh.cancel_reason }));
    });
  }
  return present(actor, await repo.loadReservation(pool, id));
}

async function cancelReservation(user, id, rawBody, expectedVersion, ctx) {
  const body = v.assertBody(rawBody, ['reason']);
  // BR025: a reason is mandatory.
  const reason = v.requiredString(body.reason, 'reason', { ...v.LIMITS.cancelReason, code: 'CANCEL_REASON_REQUIRED' });
  await preCheck(user, id);

  const [[snapshot]] = await pool.query('SELECT status FROM reservations WHERE id = ?', [id]);
  // Retry of an earlier cancellation whose order calls did not finish.
  if (snapshot.status === 'CANCEL_PENDING') return finishCancellation(id, user, ctx.requestId);

  // BR024: a booking with an order already sent to the kitchen is not cancelled; nothing is changed.
  if (snapshot.status === 'CONFIRMED') {
    const locked = lockedOrder(await orderClient.listOrders(id, ctx.requestId));
    if (locked) {
      throw conflict('ORDER_LOCKED', 'Đơn đặt bàn có order đã gửi chế biến, không thể hủy', {
        orderId: locked.id,
        orderStatus: locked.status,
      });
    }
  }

  const to = await withTransaction(async (conn) => {
    const res = await repo.lockReservation(conn, id);
    repo.assertStatus(res, ['PENDING', 'CONFIRMED'], 'RESERVATION_NOT_CANCELLABLE');
    repo.assertVersion(res, expectedVersion);
    // The order check above was made for this status; if it moved in between, the caller must reload.
    if (res.status !== snapshot.status) {
      throw conflict('VERSION_CONFLICT', 'Dữ liệu đã được người khác cập nhật, vui lòng tải lại', {
        currentVersion: res.version,
      });
    }
    // BR021: only before the service time.
    if (isPast(res)) throw unprocessable('RESERVATION_STARTED', 'Đã đến giờ phục vụ, không thể hủy đơn đặt bàn');

    // A PENDING booking has no table and no order, so it is cancelled at once.
    const target = res.status === 'PENDING' ? 'CANCELLED' : 'CANCEL_PENDING';
    await conn.query(
      `UPDATE reservations
          SET status = ?, cancel_reason = ?, cancelled_by = ?, cancel_requested_at = NOW(3),
              cancelled_at = IF(? = 'CANCELLED', NOW(3), NULL), version = version + 1
        WHERE id = ?`,
      [target, reason, user.accountId, target, id],
    );
    await repo.writeAudit(conn, {
      reservationId: id,
      action: target === 'CANCELLED' ? 'CANCELLED' : 'CANCEL_REQUESTED',
      from: res.status,
      to: target,
      user,
      requestId: ctx.requestId,
      details: { reason },
    });
    if (target === 'CANCELLED') {
      const row = await repo.loadReservation(conn, id);
      await notifications.enqueue(conn, 'CANCELLED', notice(row, { reason }));
    }
    return target;
  });

  if (to === 'CANCEL_PENDING') return finishCancellation(id, user, ctx.requestId);
  return present(user, await repo.loadReservation(pool, id));
}

// Background retry for bookings stuck in CANCEL_PENDING (order-service was unreachable).
async function reconcileCancellations() {
  const [rows] = await pool.query(
    `SELECT id FROM reservations WHERE status = 'CANCEL_PENDING' AND cancel_requested_at < NOW(3) - INTERVAL 10 SECOND
      ORDER BY cancel_requested_at LIMIT 20`,
  );
  for (const { id } of rows) {
    try {
      await finishCancellation(id, SYSTEM_ACTOR, `reconcile-${crypto.randomUUID()}`);
    } catch (err) {
      logger.warn('cancellation still pending', { reservationId: id, code: err.code });
    }
  }
}

// ---------- Internal API for order-service ----------------------------------------------------
async function orderContext(id) {
  const [[row]] = await pool.query(
    'SELECT id, branch_id, table_id, status, starts_at, ends_at, party_size FROM reservations WHERE id = ?',
    [id],
  );
  if (!row) throw notFound('RESERVATION_NOT_FOUND', 'Không tìm thấy đơn đặt bàn');
  if (row.status !== 'CONFIRMED') {
    throw conflict('INVALID_RESERVATION_STATE', 'Chỉ tạo order cho đơn đặt bàn đã xác nhận', { status: row.status });
  }
  return {
    id: row.id,
    branchId: row.branch_id,
    tableId: row.table_id,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    partySize: row.party_size,
  };
}

module.exports = {
  createPublic,
  listReservations,
  getReservation,
  confirmReservation,
  updateReservation,
  cancelReservation,
  reconcileCancellations,
  orderContext,
};
