'use strict';

const { badRequest } = require('../errors');

const ID_RE = /^[0-9A-Za-z-]{1,36}$/;
// Letters (any language), spaces and . ' - only; must start with a letter.
const NAME_RE = /^\p{L}[\p{L}\p{M}\s.'-]*$/u;
const PHONE_RE = /^0[35789]\d{8}$/;

const SERVICE_TYPES = ['DINE_IN', 'PRE_ORDER'];
const STATUSES = ['PENDING', 'CONFIRMED', 'CANCEL_PENDING', 'CANCELLED'];

const LIMITS = Object.freeze({
  customerName: { min: 2, max: 100 },
  cancelReason: { min: 5, max: 500 },
});

function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function requiredId(value, field) {
  if (!isId(value)) throw badRequest('VALIDATION_ERROR', `Trường ${field} không hợp lệ`, { field });
  return value;
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requiredId(value, field);
}

// Rejects arrays/primitives and any field the endpoint does not accept (e.g. a client trying to send "status").
function assertBody(body, allowed) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_BODY', 'Body phải là một JSON object');
  }
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw badRequest('UNKNOWN_FIELD', `Trường không được phép: ${unknown.join(', ')}`, { fields: unknown, allowed });
  }
  return body;
}

function requiredString(value, field, { min = 1, max, code = 'VALIDATION_ERROR' }) {
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest(code, `Trường ${field} là bắt buộc`, { field });
  }
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < min) throw badRequest(code, `Trường ${field} cần ít nhất ${min} ký tự`, { field, min });
  if (text.length > max) throw badRequest('VALIDATION_ERROR', `Trường ${field} tối đa ${max} ký tự`, { field, max });
  return text;
}

function oneOf(value, allowed, field) {
  if (value === undefined || value === '') return null;
  if (!allowed.includes(value)) {
    throw badRequest('VALIDATION_ERROR', `${field} phải là một trong: ${allowed.join(', ')}`, { field });
  }
  return value;
}

function customerName(value, field = 'customerName') {
  const text = requiredString(value, field, { ...LIMITS.customerName, code: 'INVALID_NAME' });
  if (!NAME_RE.test(text)) {
    throw badRequest('INVALID_NAME', 'Họ tên chỉ gồm chữ cái và khoảng trắng', { field });
  }
  return text;
}

// "+84 90 123 4567", "84901234567", "090.123.4567" -> "0901234567"
function normalizePhone(value, field = 'phone') {
  const raw = typeof value === 'string' ? value.replace(/[\s.()-]/g, '') : '';
  const local = raw.replace(/^\+?84(?=\d{9}$)/, '0');
  if (!PHONE_RE.test(local)) {
    throw badRequest('INVALID_PHONE', 'Số điện thoại không hợp lệ (10 số di động Việt Nam, ví dụ 0901234567)', { field });
  }
  return local;
}

function partySize(value, max, field = 'partySize') {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw badRequest('INVALID_PARTY_SIZE', `Số lượng khách phải là số nguyên từ 1 đến ${max}`, { field, max });
  }
  return n;
}

function serviceType(value, field = 'serviceType') {
  if (!SERVICE_TYPES.includes(value)) {
    throw badRequest('VALIDATION_ERROR', `Hình thức ăn phải là một trong: ${SERVICE_TYPES.join(', ')}`, { field });
  }
  return value;
}

// Never log a customer's full phone number.
const maskPhone = (phone) => (phone ? `${phone.slice(0, 3)}****${phone.slice(-3)}` : phone);

module.exports = {
  LIMITS,
  SERVICE_TYPES,
  STATUSES,
  isId,
  requiredId,
  optionalId,
  assertBody,
  requiredString,
  oneOf,
  customerName,
  normalizePhone,
  partySize,
  serviceType,
  maskPhone,
};
