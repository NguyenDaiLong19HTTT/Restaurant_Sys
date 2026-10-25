'use strict';

const crypto = require('node:crypto');

// DB-261025-7K2QF (prefix-yymmdd-random)
function makeCode(prefix) {
  const now = new Date();
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(5, '0').slice(-5);
  return `${prefix}-${date}-${rand}`;
}

function mapTable(r) {
  return {
    id: r.id,
    branchId: r.branch_id,
    code: r.code,
    name: r.name,
    capacity: r.capacity,
    location: r.location,
    status: r.status,
  };
}

// r = reservations row joined with customers (customer_*) and tables (table_*), see repo.RES_SELECT.
function mapReservation(r) {
  return {
    id: r.id,
    code: r.code,
    branchId: r.branch_id,
    customer: { id: r.customer_id, fullName: r.customer_name, phone: r.customer_phone },
    table: r.table_id ? { id: r.table_id, code: r.table_code, name: r.table_name, capacity: r.table_capacity } : null,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    partySize: r.party_size,
    serviceType: r.service_type,
    status: r.status,
    cancelReason: r.cancel_reason,
    confirmedBy: r.confirmed_by,
    confirmedAt: r.confirmed_at,
    cancelledBy: r.cancelled_by,
    cancelRequestedAt: r.cancel_requested_at,
    cancelledAt: r.cancelled_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// What an anonymous customer gets back: only their own submission, no lookups by ID.
function mapPublicReservation(r) {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    branchId: r.branch_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    partySize: r.party_size,
    serviceType: r.service_type,
  };
}

function mapNotification(r) {
  return {
    id: r.id,
    reservationId: r.reservation_id,
    reservationCode: r.reservation_code,
    channel: r.channel,
    recipient: r.recipient,
    event: r.event,
    content: r.content,
    status: r.status,
    attempts: r.attempts,
    createdAt: r.created_at,
    processedAt: r.processed_at,
  };
}

module.exports = { makeCode, mapTable, mapReservation, mapPublicReservation, mapNotification };
