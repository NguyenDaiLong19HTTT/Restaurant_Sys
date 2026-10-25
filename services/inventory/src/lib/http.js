'use strict';

const { badRequest } = require('../errors');

function toInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^\d+$/.test(String(value)) ? Number(value) : NaN;
}

function parsePaging(query) {
  const page = toInt(query.page, 1);
  const limit = toInt(query.limit, 20);
  if (!(page >= 1)) throw badRequest('VALIDATION_ERROR', 'page phải là số nguyên >= 1', { field: 'page' });
  if (!(limit >= 1 && limit <= 100)) {
    throw badRequest('VALIDATION_ERROR', 'limit phải trong khoảng 1–100', { field: 'limit' });
  }
  return { page, limit, offset: (page - 1) * limit };
}

function parseIfMatch(raw) {
  if (!raw) return null;
  const match = String(raw).trim().match(/^(?:W\/)?"?(\d+)"?$/);
  return match ? Number(match[1]) : NaN;
}

function requireIfMatch(req) {
  const version = parseIfMatch(req.get('if-match'));
  if (version === null) {
    throw badRequest('IF_MATCH_REQUIRED', 'Thiếu header If-Match chứa version đã đọc');
  }
  if (Number.isNaN(version)) throw badRequest('INVALID_IF_MATCH', 'If-Match phải là số version, ví dụ "3"');
  return version;
}

function idempotencyKey(req, { required = false } = {}) {
  const key = req.get('idempotency-key');
  if (!key) {
    if (required) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Thiếu header Idempotency-Key');
    return null;
  }
  if (key.length > 128 || !/^[\w.:-]+$/.test(key)) {
    throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key không hợp lệ (tối đa 128 ký tự chữ, số, - _ . :)');
  }
  return key;
}

function setEtag(res, version) {
  if (version !== undefined && version !== null) res.set('ETag', `"${version}"`);
}

// result = { status, body, replayed? } produced by services that run idempotently.
function sendResult(res, result) {
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  setEtag(res, result.body?.data?.version);
  res.status(result.status).json(result.body);
}

module.exports = { parsePaging, parseIfMatch, requireIfMatch, idempotencyKey, setEtag, sendResult };
