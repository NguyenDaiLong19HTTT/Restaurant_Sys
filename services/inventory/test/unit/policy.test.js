'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, PERMISSIONS, can, canViewTransfer, transferActions, slipActions } = require('../../src/policy');
const { assertBody, requiredString } = require('../../src/lib/validate');

const owner = { accountId: 'o', role: ROLES.OWNER, branchId: null };
const mgrA = { accountId: 'a', role: ROLES.MANAGER, branchId: 'A' };
const mgrB = { accountId: 'b', role: ROLES.MANAGER, branchId: 'B' };
const waiter = { accountId: 'w', role: ROLES.WAITER, branchId: 'A' };

const pending = { status: 'PENDING_APPROVAL', requester_branch_id: 'A', supplier_branch_id: null };
const approved = { status: 'APPROVED', requester_branch_id: 'A', supplier_branch_id: 'B' };

test('staff roles outside inventory have no permission at all', () => {
  for (const permission of Object.keys(PERMISSIONS)) assert.equal(can(waiter, permission), false, permission);
});

test('only managers create/confirm; only owner approves/rejects', () => {
  assert.ok(can(mgrA, 'transfer:create') && !can(owner, 'transfer:create'));
  assert.ok(can(owner, 'transfer:approve') && !can(mgrA, 'transfer:approve'));
  assert.ok(can(mgrA, 'export:confirm') && !can(owner, 'export:confirm'));
});

test('transfer visibility follows branch involvement', () => {
  assert.ok(canViewTransfer(owner, pending));
  assert.ok(canViewTransfer(mgrA, pending));
  assert.ok(!canViewTransfer(mgrB, pending));
  assert.ok(canViewTransfer(mgrB, approved)); // supplier side
  assert.ok(!canViewTransfer(waiter, pending));
});

test('allowed actions depend on role, branch and status', () => {
  assert.deepEqual(transferActions(mgrA, pending), ['EDIT', 'DELETE']);
  assert.deepEqual(transferActions(owner, pending), ['APPROVE', 'REJECT']);
  assert.deepEqual(transferActions(mgrB, pending), []);
  assert.deepEqual(transferActions(mgrA, approved), []);
  assert.deepEqual(transferActions(owner, approved), []);
});

test('slip confirmation only for the branch on the slip, while pending', () => {
  const slip = { status: 'PENDING', branch_id: 'B', request_status: 'APPROVED' };
  assert.deepEqual(slipActions(mgrB, 'export', slip), ['CONFIRM']);
  assert.deepEqual(slipActions(mgrA, 'export', slip), []);
  assert.deepEqual(slipActions(owner, 'export', slip), []);
  assert.deepEqual(slipActions(mgrB, 'export', { ...slip, status: 'CONFIRMED' }), []);
  assert.deepEqual(slipActions(mgrB, 'import', slip), []); // request not yet EXPORTED
});

test('assertBody rejects unknown fields and non-objects', () => {
  assert.deepEqual(assertBody(undefined, ['a']), {});
  assert.throws(() => assertBody({ a: 1, status: 'X' }, ['a']), (e) => e.code === 'UNKNOWN_FIELD');
  assert.throws(() => assertBody([1], ['a']), (e) => e.code === 'INVALID_BODY');
  assert.throws(() => assertBody('x', ['a']), (e) => e.code === 'INVALID_BODY');
});

test('requiredString enforces trimmed min/max length', () => {
  assert.equal(requiredString('  hello ', 'reason', { min: 5, max: 10 }), 'hello');
  assert.throws(() => requiredString('abcd', 'reason', { min: 5, max: 10 }));
  assert.throws(() => requiredString('a'.repeat(11), 'reason', { min: 1, max: 10 }));
  assert.throws(() => requiredString('   ', 'reason', { min: 1, max: 10 }));
});
