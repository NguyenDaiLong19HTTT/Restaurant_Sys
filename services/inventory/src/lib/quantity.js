'use strict';

// Quantities are DECIMAL(14,3) kept as strings end to end; comparisons happen in SQL.
const QUANTITY_RE = /^(?:0|[1-9]\d{0,10})(?:\.\d{1,3})?$/;

function parseQuantity(value) {
  let text = null;
  if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else if (typeof value === 'string') text = value.trim();
  if (!text || !QUANTITY_RE.test(text)) return null;
  if (/^0(?:\.0+)?$/.test(text)) return null;
  return text;
}

// "20.500" -> "20.5", "5.000" -> "5"
function formatQuantity(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

module.exports = { parseQuantity, formatQuantity };
