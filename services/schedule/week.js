const DAY = 86400000;
const HOUR = 3600000;
const VN_OFFSET = 7 * HOUR;

export function weekOf(utcValue) {
  const local = new Date(new Date(utcValue).getTime() + VN_OFFSET);
  const localDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return localDay - ((local.getUTCDay() + 6) % 7) * DAY;
}

export function registrationPeriod(now = new Date()) {
  const monday = weekOf(now);
  return {
    opensAt: monday + 4 * DAY - VN_OFFSET,
    closesAt: monday + 7 * DAY - VN_OFFSET,
    targetWeek: monday + 7 * DAY
  };
}

export function registrationDeadline(shiftStart) {
  return new Date(weekOf(shiftStart) - VN_OFFSET);
}

export function isNextWeekShift(startsAt, endsAt, now = new Date()) {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const targetWeek = weekOf(now) + 7 * DAY;
  return Number.isFinite(start) && Number.isFinite(end) && end > start &&
    weekOf(start) === targetWeek && weekOf(end - 1) === targetWeek;
}

export function canRegister(shiftStart, now = new Date()) {
  const period = registrationPeriod(now);
  const instant = now.getTime();
  return instant >= period.opensAt && instant < period.closesAt && weekOf(shiftStart) === period.targetWeek;
}

export function sqlUtc(value) {
  return new Date(value).toISOString().slice(0,19).replace('T',' ');
}
