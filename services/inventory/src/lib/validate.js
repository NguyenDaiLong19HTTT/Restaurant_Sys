'use strict';

const { badRequest, unprocessable } = require('../errors');
const { parseQuantity } = require('./quantity');

const ID_RE = /^[0-9A-Za-z-]{1,36}$/;
const MAX_ITEMS = 50;
const MAX_QUANTITY = 1_000_000;
const ITEM_FIELDS = ['ingredientId', 'quantity', 'note'];

const LIMITS = Object.freeze({
  reason: { min: 5, max: 500 },
  rejectionReason: { min: 5, max: 500 },
  note: { max: 255 },
  maxItems: MAX_ITEMS,
  maxQuantity: MAX_QUANTITY,
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
  const text = value.trim();
  if (text.length < min) throw badRequest(code, `Trường ${field} cần ít nhất ${min} ký tự`, { field, min });
  if (text.length > max) throw badRequest('VALIDATION_ERROR', `Trường ${field} tối đa ${max} ký tự`, { field, max });
  return text;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('VALIDATION_ERROR', `Trường ${field} phải là chuỗi`, { field });
  const text = value.trim();
  if (text.length > max) throw badRequest('VALIDATION_ERROR', `Trường ${field} tối đa ${max} ký tự`, { field, max });
  return text || null;
}

function oneOf(value, allowed, field) {
  if (value === undefined || value === '') return null;
  if (!allowed.includes(value)) {
    throw badRequest('VALIDATION_ERROR', `${field} phải là một trong: ${allowed.join(', ')}`, { field });
  }
  return value;
}

function parseItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw unprocessable('EMPTY_ITEMS', 'Yêu cầu điều phối phải có ít nhất một nguyên liệu', { field: 'items' });
  }
  if (items.length > MAX_ITEMS) {
    throw badRequest('VALIDATION_ERROR', `Tối đa ${MAX_ITEMS} nguyên liệu mỗi yêu cầu`, { field: 'items' });
  }
  const seen = new Set();
  return items.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest('VALIDATION_ERROR', `items[${i}] không hợp lệ`, { field: `items[${i}]` });
    }
    const unknown = Object.keys(item).filter((key) => !ITEM_FIELDS.includes(key));
    if (unknown.length) {
      throw badRequest('UNKNOWN_FIELD', `items[${i}] có trường không được phép: ${unknown.join(', ')}`, {
        field: `items[${i}]`,
        fields: unknown,
      });
    }
    const ingredientId = requiredId(item.ingredientId, `items[${i}].ingredientId`);
    if (seen.has(ingredientId)) {
      throw unprocessable('DUPLICATE_INGREDIENT', 'Mỗi nguyên liệu chỉ được xuất hiện một lần trong yêu cầu', {
        field: `items[${i}].ingredientId`,
        ingredientId,
      });
    }
    seen.add(ingredientId);
    const quantity = parseQuantity(item.quantity);
    if (!quantity || Number(quantity) > MAX_QUANTITY) {
      throw badRequest('INVALID_QUANTITY', 'Số lượng phải lớn hơn 0, tối đa 1.000.000 và 3 chữ số thập phân', {
        field: `items[${i}].quantity`,
      });
    }
    return { ingredientId, quantity, note: optionalString(item.note, `items[${i}].note`, LIMITS.note.max) };
  });
}

module.exports = {
  LIMITS,
  isId,
  requiredId,
  optionalId,
  assertBody,
  requiredString,
  optionalString,
  oneOf,
  parseItems,
};
