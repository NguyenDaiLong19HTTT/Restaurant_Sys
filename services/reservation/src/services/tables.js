'use strict';

const config = require('../config');
const { pool } = require('../db');
const { badRequest, notFound } = require('../errors');
const { parseStartsAt, addMinutes, localDayRange, localParts } = require('../lib/time');
const { partySize, optionalId } = require('../lib/validate');
const { assertBranchScope } = require('../middleware/auth');
const { mapTable } = require('./mappers');
const { HOLDING, RES_SELECT } = require('./repo');

function durationMinutes(value) {
  if (value === undefined || value === '') return config.booking.durationMinutes;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 30 || n > 360) {
    throw badRequest('VALIDATION_ERROR', 'durationMinutes phải là số nguyên từ 30 đến 360', { field: 'durationMinutes' });
  }
  return n;
}

/**
 * UC04 steps 5–6: tables of the branch that seat the party, each with whether it is free in
 * [startsAt, startsAt + duration). Read-only preview; confirm/update re-check under row locks.
 * `excludeReservationId` ignores that booking's own slot (used when previewing an update).
 */
async function availability(user, branchId, query) {
  assertBranchScope(user, branchId);
  const startsAt = parseStartsAt(query.startsAt);
  const party = partySize(query.partySize, config.booking.maxPartySize);
  const endsAt = addMinutes(startsAt, durationMinutes(query.durationMinutes));
  const excludeId = optionalId(query.excludeReservationId, 'excludeReservationId');

  const [tables] = await pool.query(
    `SELECT * FROM tables WHERE branch_id = ? AND status = 'ACTIVE' AND capacity >= ? ORDER BY capacity, code, id`,
    [branchId, party],
  );
  const [busy] = tables.length
    ? await pool.query(
        `SELECT table_id, code, starts_at, ends_at FROM reservations
          WHERE table_id IN (?) AND status IN ${HOLDING} AND starts_at < ? AND ends_at > ? AND id <> ?
          ORDER BY starts_at`,
        [tables.map((t) => t.id), endsAt, startsAt, excludeId ?? ''],
      )
    : [[]];

  const result = tables.map((t) => {
    const conflicts = busy
      .filter((b) => b.table_id === t.id)
      .map((b) => ({ reservationCode: b.code, startsAt: b.starts_at, endsAt: b.ends_at }));
    return { ...mapTable(t), available: conflicts.length === 0, conflicts };
  });
  return {
    branchId,
    startsAt,
    endsAt,
    partySize: party,
    tables: result,
    // Same choice the server makes when it has to move a confirmed booking (smallest suitable table).
    suggestedTableId: result.find((t) => t.available)?.id ?? null,
  };
}

/**
 * Day view for reception: every table of the branch with the bookings holding it that day, plus
 * PENDING bookings still waiting for a table. "Booked now" means the current time falls inside a
 * confirmed booking's slot; whether guests have actually arrived is not tracked (no such step in v1).
 */
async function schedule(user, branchId, query) {
  assertBranchScope(user, branchId);
  const date = query.date ? String(query.date) : localParts(new Date()).date;
  const { from, to } = localDayRange(date);

  const [tables] = await pool.query('SELECT * FROM tables WHERE branch_id = ? ORDER BY status, capacity, code, id', [
    branchId,
  ]);
  const [bookings] = await pool.query(
    `${RES_SELECT}
      WHERE r.branch_id = ? AND r.status IN ('PENDING', ${HOLDING.slice(1, -1)}) AND r.starts_at < ? AND r.ends_at > ?
      ORDER BY r.starts_at, r.code`,
    [branchId, to, from],
  );

  const now = Date.now();
  const slim = (r) => ({
    id: r.id,
    code: r.code,
    status: r.status,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    partySize: r.party_size,
    customerName: r.customer_name,
  });
  const result = tables.map((t) => {
    const own = bookings.filter((b) => b.table_id === t.id).map(slim);
    const current = own.find((b) => new Date(b.startsAt) <= now && new Date(b.endsAt) > now) ?? null;
    const next = own.find((b) => new Date(b.startsAt) > now) ?? null;
    return { ...mapTable(t), bookings: own, current, next };
  });
  return {
    branchId,
    date,
    from,
    to,
    tables: result,
    unassigned: bookings.filter((b) => !b.table_id).map(slim),
  };
}

// For order-service: GET /internal/v1/tables/{id}/order-context
async function tableContext(id) {
  const [[row]] = await pool.query('SELECT id, branch_id, capacity, status FROM tables WHERE id = ?', [id]);
  if (!row) throw notFound('TABLE_NOT_FOUND', 'Không tìm thấy bàn');
  return { id: row.id, branchId: row.branch_id, capacity: row.capacity, status: row.status };
}

module.exports = { availability, schedule, tableContext };
