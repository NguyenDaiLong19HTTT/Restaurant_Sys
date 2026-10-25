'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuantity, formatQuantity } = require('../../src/lib/quantity');
const { parseIfMatch } = require('../../src/lib/http');
const { parseItems } = require('../../src/lib/validate');

test('parseQuantity accepts positive decimals with up to 3 places', () => {
  assert.equal(parseQuantity('20'), '20');
  assert.equal(parseQuantity(' 1.5 '), '1.5');
  assert.equal(parseQuantity(0.125), '0.125');
  assert.equal(parseQuantity('0.001'), '0.001');
});

test('parseQuantity rejects zero, negatives, too many decimals and junk', () => {
  for (const bad of ['0', '0.000', '-1', '1.2345', 'abc', '', '1e3', '01', null, undefined, NaN, Infinity, {}]) {
    assert.equal(parseQuantity(bad), null, `expected ${String(bad)} to be rejected`);
  }
});

test('formatQuantity trims trailing zeros from DECIMAL strings', () => {
  assert.equal(formatQuantity('20.000'), '20');
  assert.equal(formatQuantity('1.500'), '1.5');
  assert.equal(formatQuantity('-5.250'), '-5.25');
  assert.equal(formatQuantity('100'), '100');
});

test('parseIfMatch reads quoted, weak and bare versions', () => {
  assert.equal(parseIfMatch('"3"'), 3);
  assert.equal(parseIfMatch('W/"12"'), 12);
  assert.equal(parseIfMatch('7'), 7);
  assert.equal(parseIfMatch(undefined), null);
  assert.ok(Number.isNaN(parseIfMatch('abc')));
});

test('parseItems rejects an empty list', () => {
  assert.throws(() => parseItems([]), (e) => e.code === 'EMPTY_ITEMS' && e.status === 422);
  assert.throws(() => parseItems(undefined), (e) => e.code === 'EMPTY_ITEMS');
});

test('parseItems rejects duplicate ingredients', () => {
  assert.throws(
    () => parseItems([{ ingredientId: 'a', quantity: '1' }, { ingredientId: 'a', quantity: '2' }]),
    (e) => e.code === 'DUPLICATE_INGREDIENT' && e.status === 422,
  );
});

test('parseItems rejects invalid quantity and normalises notes', () => {
  assert.throws(() => parseItems([{ ingredientId: 'a', quantity: 0 }]), (e) => e.code === 'INVALID_QUANTITY');
  assert.deepEqual(parseItems([{ ingredientId: 'a', quantity: 2, note: '  ' }]), [
    { ingredientId: 'a', quantity: '2', note: null },
  ]);
});
