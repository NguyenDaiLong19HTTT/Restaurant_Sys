'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, PERMISSIONS, can, reservationActions } = require('../../src/policy');

const receptionA = { accountId: 'r', role: ROLES.RECEPTION, branchId: 'A' };
const receptionB = { accountId: 'rb', role: ROLES.RECEPTION, branchId: 'B' };
const managerA = { accountId: 'm', role: ROLES.MANAGER, branchId: 'A' };
const owner = { accountId: 'o', role: ROLES.OWNER, branchId: null };
const waiterA = { accountId: 'w', role: ROLES.WAITER, branchId: 'A' };

const now = Date.parse('2026-10-25T03:00:00Z');
const future = '2026-10-25T11:00:00Z';
const past = '2026-10-25T02:00:00Z';
const row = (status, startsAt = future) => ({ status, branch_id: 'A', starts_at: startsAt });

test('only reception staff hold reservation permissions', () => {
  for (const permission of Object.keys(PERMISSIONS)) {
    assert.ok(can(receptionA, permission), permission);
    for (const other of [managerA, owner, waiterA]) assert.equal(can(other, permission), false, `${other.role} ${permission}`);
  }
});

test('pending booking: confirm, edit, cancel for the same branch only', () => {
  assert.deepEqual(reservationActions(receptionA, row('PENDING'), now), ['CONFIRM', 'EDIT', 'CANCEL']);
  assert.deepEqual(reservationActions(receptionB, row('PENDING'), now), []);
  assert.deepEqual(reservationActions(managerA, row('PENDING'), now), []);
});

test('confirmed booking can be edited or cancelled but not confirmed again', () => {
  assert.deepEqual(reservationActions(receptionA, row('CONFIRMED'), now), ['EDIT', 'CANCEL']);
});

test('nothing is allowed once the service time has started (BR021)', () => {
  assert.deepEqual(reservationActions(receptionA, row('PENDING', past), now), []);
  assert.deepEqual(reservationActions(receptionA, row('CONFIRMED', past), now), []);
});

test('cancelled is final; cancel-pending can only be retried', () => {
  assert.deepEqual(reservationActions(receptionA, row('CANCELLED'), now), []);
  assert.deepEqual(reservationActions(receptionA, row('CANCEL_PENDING'), now), ['RETRY_CANCEL']);
});
