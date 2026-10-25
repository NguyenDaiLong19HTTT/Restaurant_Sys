'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../../src/lib/validate');
const { parseStartsAt, assertBookingTime, localDayRange, formatLocal, localParts } = require('../../src/lib/time');
const { parseIfMatch } = require('../../src/lib/http');

const rules = { minLeadMinutes: 30, maxAdvanceDays: 30, firstStart: '09:00', lastStart: '21:00' };
const now = Date.parse('2026-10-25T03:00:00Z'); // 10:00 in Vietnam

test('phone numbers are normalised to 10-digit Vietnamese mobiles', () => {
  assert.equal(v.normalizePhone('0901234567'), '0901234567');
  assert.equal(v.normalizePhone('+84 90 123 4567'), '0901234567');
  assert.equal(v.normalizePhone('84901234567'), '0901234567');
  assert.equal(v.normalizePhone('090.123.4567'), '0901234567');
  for (const bad of ['012345678', '0201234567', '09012345678', 'abc', '', undefined, 901234567]) {
    assert.throws(() => v.normalizePhone(bad), (e) => e.code === 'INVALID_PHONE', String(bad));
  }
});

test('customer name: letters only, trimmed, 2–100 characters', () => {
  assert.equal(v.customerName('  Nguyễn   Văn An '), 'Nguyễn Văn An');
  assert.throws(() => v.customerName('A'), (e) => e.code === 'INVALID_NAME');
  assert.throws(() => v.customerName('An123'), (e) => e.code === 'INVALID_NAME');
  assert.throws(() => v.customerName('<script>'), (e) => e.code === 'INVALID_NAME');
  assert.throws(() => v.customerName('x'.repeat(101)));
});

test('party size is an integer within the limit', () => {
  assert.equal(v.partySize(4, 20), 4);
  assert.equal(v.partySize('6', 20), 6);
  for (const bad of [0, -1, 2.5, 21, '4a', null]) {
    assert.throws(() => v.partySize(bad, 20), (e) => e.code === 'INVALID_PARTY_SIZE', String(bad));
  }
});

test('service type must be one of the known values', () => {
  assert.equal(v.serviceType('DINE_IN'), 'DINE_IN');
  assert.throws(() => v.serviceType('TAKEAWAY'));
});

test('assertBody rejects unknown fields such as status', () => {
  assert.throws(() => v.assertBody({ status: 'CONFIRMED' }, ['phone']), (e) => e.code === 'UNKNOWN_FIELD');
  assert.throws(() => v.assertBody([], ['phone']), (e) => e.code === 'INVALID_BODY');
});

test('startsAt requires an explicit time zone', () => {
  assert.equal(parseStartsAt('2026-10-25T18:00:00+07:00').toISOString(), '2026-10-25T11:00:00.000Z');
  assert.equal(parseStartsAt('2026-10-25T11:00Z').toISOString(), '2026-10-25T11:00:00.000Z');
  assert.throws(() => parseStartsAt('2026-10-25T18:00:00'), (e) => e.code === 'INVALID_DATETIME');
  assert.throws(() => parseStartsAt('25/10/2026 18:00'), (e) => e.code === 'INVALID_DATETIME');
  assert.throws(() => parseStartsAt('2026-02-30T18:00:00+07:00'), (e) => e.code === 'INVALID_DATETIME');
});

test('booking window: lead time, max advance and opening hours in local time', () => {
  const at = (iso) => () => assertBookingTime(new Date(iso), rules, now);
  assert.doesNotThrow(at('2026-10-25T18:00:00+07:00'));
  assert.doesNotThrow(at('2026-10-25T21:00:00+07:00'));
  assert.throws(at('2026-10-25T10:15:00+07:00'), (e) => e.code === 'START_TOO_SOON');
  assert.throws(at('2026-10-25T09:00:00+07:00'), (e) => e.code === 'START_TOO_SOON');
  assert.throws(at('2026-12-01T18:00:00+07:00'), (e) => e.code === 'START_TOO_FAR');
  assert.throws(at('2026-10-26T08:30:00+07:00'), (e) => e.code === 'OUTSIDE_OPENING_HOURS');
  assert.throws(at('2026-10-26T21:30:00+07:00'), (e) => e.code === 'OUTSIDE_OPENING_HOURS');
});

test('local day range and formatting use Vietnam time', () => {
  const { from, to } = localDayRange('2026-10-25');
  assert.equal(from.toISOString(), '2026-10-24T17:00:00.000Z');
  assert.equal(to.toISOString(), '2026-10-25T17:00:00.000Z');
  assert.equal(formatLocal(new Date('2026-10-25T11:00:00Z')), '18:00 ngày 25/10/2026');
  assert.deepEqual(localParts(new Date('2026-10-24T17:30:00Z')), { date: '2026-10-25', minutes: 30 });
  assert.throws(() => localDayRange('25-10-2026'));
});

test('If-Match accepts quoted, bare and weak versions', () => {
  assert.equal(parseIfMatch('"3"'), 3);
  assert.equal(parseIfMatch('3'), 3);
  assert.equal(parseIfMatch('W/"3"'), 3);
  assert.ok(Number.isNaN(parseIfMatch('"abc"')));
  assert.equal(parseIfMatch(undefined), null);
});

test('phone numbers are masked for logs', () => {
  assert.equal(v.maskPhone('0901234567'), '090****567');
});
