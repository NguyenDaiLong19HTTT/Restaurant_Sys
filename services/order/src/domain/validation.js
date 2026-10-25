'use strict';

const HttpError = require('./http-error');

function positiveInteger(value, field, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > max) {
    throw new HttpError(422, 'VALIDATION_ERROR', `${field} must be a positive integer`, { field });
  }
  return number;
}

function expectedVersion(req) {
  const raw = req.get('If-Match');
  if (!raw) throw new HttpError(400, 'IF_MATCH_REQUIRED', 'If-Match with the order version is required');
  const match = raw.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) throw new HttpError(400, 'INVALID_IF_MATCH', 'If-Match must contain the version number');
  return Number(match[1]);
}

function idempotencyKey(req, allowRequestId = false) {
  const key = req.get('Idempotency-Key') || (allowRequestId ? req.get('X-Request-Id') : '');
  if (!key || key.length > 128) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key is required');
  return key;
}

module.exports = { positiveInteger, expectedVersion, idempotencyKey };
