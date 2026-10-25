'use strict';

const { badRequest, unprocessable } = require('../errors');

// Vietnam has no DST, so a fixed UTC+7 offset is exact for Asia/Ho_Chi_Minh.
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
// ISO 8601 with an explicit offset: the API never guesses the client's time zone.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseStartsAt(value, field = 'startsAt') {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) {
    throw badRequest('INVALID_DATETIME', 'Thời gian đặt phải theo ISO 8601 có múi giờ, ví dụ 2026-10-25T18:00:00+07:00', {
      field,
    });
  }
  const ms = Date.parse(value);
  // Date.parse rolls 2026-02-30 over to March; compare the calendar parts to reject such dates.
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(y, m - 1, d));
  const realDate = calendar.getUTCFullYear() === y && calendar.getUTCMonth() === m - 1 && calendar.getUTCDate() === d;
  if (Number.isNaN(ms) || !realDate) throw badRequest('INVALID_DATETIME', 'Thời gian đặt không tồn tại', { field });
  return new Date(Math.floor(ms / MINUTE) * MINUTE);
}

const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * MINUTE);

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// "2026-10-25" and minutes since local midnight, in Vietnam time.
function localParts(date) {
  const local = new Date(date.getTime() + VN_OFFSET_MS);
  return {
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** BR003: the requested start must be in the booking window and inside opening hours (local time). */
function assertBookingTime(startsAt, rules, now = Date.now(), field = 'startsAt') {
  if (startsAt.getTime() < now + rules.minLeadMinutes * MINUTE) {
    throw unprocessable('START_TOO_SOON', `Thời gian đặt phải sau thời điểm hiện tại ít nhất ${rules.minLeadMinutes} phút`, {
      field,
    });
  }
  if (startsAt.getTime() > now + rules.maxAdvanceDays * 24 * 60 * MINUTE) {
    throw unprocessable('START_TOO_FAR', `Chỉ nhận đặt bàn trước tối đa ${rules.maxAdvanceDays} ngày`, { field });
  }
  const { minutes } = localParts(startsAt);
  if (minutes < toMinutes(rules.firstStart) || minutes > toMinutes(rules.lastStart)) {
    throw unprocessable(
      'OUTSIDE_OPENING_HOURS',
      `Nhà hàng nhận khách bắt đầu từ ${rules.firstStart} đến ${rules.lastStart}`,
      { field, firstStart: rules.firstStart, lastStart: rules.lastStart },
    );
  }
}

// Local calendar day "YYYY-MM-DD" -> UTC [from, to) for filtering.
function localDayRange(value, field = 'date') {
  if (!LOCAL_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw badRequest('VALIDATION_ERROR', `${field} phải có dạng YYYY-MM-DD`, { field });
  }
  const from = new Date(Date.parse(`${value}T00:00:00Z`) - VN_OFFSET_MS);
  return { from, to: addMinutes(from, 24 * 60) };
}

// "18:00 ngày 25/10/2026" for SMS text.
function formatLocal(date) {
  const local = new Date(date.getTime() + VN_OFFSET_MS).toISOString();
  return `${local.slice(11, 16)} ngày ${local.slice(8, 10)}/${local.slice(5, 7)}/${local.slice(0, 4)}`;
}

module.exports = { parseStartsAt, addMinutes, localParts, assertBookingTime, localDayRange, formatLocal };
