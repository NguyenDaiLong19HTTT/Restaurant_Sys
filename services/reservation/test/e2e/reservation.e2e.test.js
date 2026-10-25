'use strict';

/**
 * Integration tests through the gateway against the running Docker stack (MySQL + real service).
 *   docker compose -f deploy/compose.yaml up -d --build
 *   BASE_URL=http://localhost:8080/api/v1 npm run test:e2e
 * Tests create bookings; reset with `docker compose -f deploy/compose.yaml down -v` afterwards.
 * Each test books its own time slot so the suite can run again on the same data. The public form is
 * rate limited per client IP (in memory): before re-running within 10 minutes, run
 * `docker compose -f deploy/compose.yaml restart reservation-service`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const BASE = process.env.BASE_URL || 'http://localhost:8080/api/v1';
const PASSWORD = process.env.DEMO_PASSWORD || '123456';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';
const B3 = '33333333-3333-4333-8333-333333333333';
const SEED = {
  pending: '72000000-0000-4000-8000-000000000001',
  withSubmittedOrder: '72000000-0000-4000-8000-000000000003',
  otherBranch: '72000000-0000-4000-8000-000000000005',
};

async function call(method, path, { token, body, ifMatch, key, headers: extra } = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const tokens = {};
async function as(username) {
  if (!tokens[username]) {
    const res = await call('POST', '/auth/login', { body: { username, password: PASSWORD } });
    assert.equal(res.status, 200, `login ${username}`);
    tokens[username] = res.body.data.accessToken;
  }
  return tokens[username];
}

// A distinct future slot per call: day 2..29 from now at 09:00–21:00 Vietnam time, random 15-minute step.
function slot(dayOffset = 2 + crypto.randomInt(0, 27), minutes = crypto.randomInt(0, 49) * 15) {
  const day = new Date(Date.now() + 7 * 3600_000 + dayOffset * 86_400_000).toISOString().slice(0, 10);
  const total = 9 * 60 + minutes;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${day}T${hh}:${mm}:00+07:00`;
}

async function book(overrides = {}) {
  const body = {
    branchId: B1,
    customerName: 'Khách Kiểm Thử',
    phone: '0909000111',
    startsAt: slot(),
    partySize: 2,
    serviceType: 'DINE_IN',
    ...overrides,
  };
  const res = await call('POST', '/reservations', { body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

async function detail(id, username = 'tn.q1') {
  const res = await call('GET', `/reservations/${id}`, { token: await as(username) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

async function freeTable(r, username = 'tn.q1') {
  const res = await call(
    'GET',
    `/branches/${r.branchId}/tables/availability?startsAt=${encodeURIComponent(r.startsAt)}&partySize=${r.partySize}`,
    { token: await as(username) },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.tables.find((t) => t.available);
}

test('customer books without an account and gets a PENDING code', async () => {
  const created = await book();
  assert.match(created.code, /^DB-\d{6}-[0-9A-Z]{5}$/);
  assert.equal(created.status, 'PENDING');
  assert.equal(created.customer, undefined, 'public response does not echo PII');

  const staff = await detail(created.id);
  assert.equal(staff.table, null, 'BR006: no table before confirmation');
  assert.equal(staff.customer.phone, '0909000111');
  assert.deepEqual(staff.allowedActions, ['CONFIRM', 'EDIT', 'CANCEL']);
  assert.equal(staff.history[0].action, 'CREATED');
});

test('public form validates input and refuses a branch that does not take bookings', async () => {
  const base = { branchId: B1, customerName: 'Khách', phone: '0909000111', startsAt: slot(), partySize: 2, serviceType: 'DINE_IN' };
  const cases = [
    [{ phone: '12345' }, 400, 'INVALID_PHONE'],
    [{ customerName: 'A1' }, 400, 'INVALID_NAME'],
    [{ partySize: 0 }, 400, 'INVALID_PARTY_SIZE'],
    [{ startsAt: '2026-10-25 18:00' }, 400, 'INVALID_DATETIME'],
    [{ startsAt: slot(3, 13 * 60) }, 422, 'OUTSIDE_OPENING_HOURS'],
    [{ startsAt: new Date(Date.now() + 5 * 60_000).toISOString() }, 422, 'START_TOO_SOON'],
    [{ partySize: 15 }, 422, 'PARTY_TOO_LARGE'],
    [{ status: 'CONFIRMED' }, 400, 'UNKNOWN_FIELD'],
    [{ branchId: B3 }, 422, 'BRANCH_NOT_ACCEPTING_RESERVATIONS'],
  ];
  for (const [patch, status, code] of cases) {
    const res = await call('POST', '/reservations', { body: { ...base, ...patch } });
    assert.equal(res.status, status, `${JSON.stringify(patch)} -> ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, code);
  }
});

test('same Idempotency-Key on the public form returns the same booking', async () => {
  const body = { branchId: B1, customerName: 'Khách Bấm Hai Lần', phone: '0909000222', startsAt: slot(), partySize: 2, serviceType: 'DINE_IN' };
  const key = crypto.randomUUID();
  const first = await call('POST', '/reservations', { body, key });
  const second = await call('POST', '/reservations', { body, key });
  assert.equal(first.status, 201);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
});

test('only reception staff of the same branch can see and act on bookings', async () => {
  const anonymous = await call('GET', `/reservations/${SEED.pending}`);
  assert.equal(anonymous.status, 401);

  for (const username of ['ql.q1', 'pv.q1', 'chuchuoi']) {
    const res = await call('GET', '/reservations', { token: await as(username) });
    assert.equal(res.status, 403, username);
    assert.equal(res.body.error.code, 'ROLE_FORBIDDEN');
  }

  const otherBranch = await call('GET', `/reservations/${SEED.otherBranch}`, { token: await as('tn.q1') });
  assert.equal(otherBranch.status, 403);
  assert.equal(otherBranch.body.error.code, 'BRANCH_SCOPE_FORBIDDEN');

  const otherList = await call('GET', `/reservations?branchId=${B2}`, { token: await as('tn.q1') });
  assert.equal(otherList.status, 403);
  const otherTables = await call('GET', `/branches/${B2}/tables/availability?startsAt=${encodeURIComponent(slot())}&partySize=2`, {
    token: await as('tn.q1'),
  });
  assert.equal(otherTables.status, 403);

  const own = await call('GET', '/reservations?status=PENDING&limit=100', { token: await as('tn.td') });
  assert.equal(own.status, 200);
  assert.ok(own.body.data.every((r) => r.branchId === B2));
});

test('confirm assigns a table; a table must fit the party and belong to the branch', async () => {
  const r = await book({ partySize: 4 });
  const token = await as('tn.q1');
  const small = '70000000-0000-4000-8000-000000000101'; // Bàn 1, 2 chỗ
  const otherBranchTable = '70000000-0000-4000-8000-000000000202';

  const tooSmall = await call('POST', `/reservations/${r.id}/confirm`, { token, ifMatch: 1, body: { tableId: small } });
  assert.equal(tooSmall.status, 422);
  assert.equal(tooSmall.body.error.code, 'TABLE_TOO_SMALL');
  const wrongBranch = await call('POST', `/reservations/${r.id}/confirm`, { token, ifMatch: 1, body: { tableId: otherBranchTable } });
  assert.equal(wrongBranch.body.error.code, 'TABLE_NOT_IN_BRANCH');
  const noIfMatch = await call('POST', `/reservations/${r.id}/confirm`, { token, body: { tableId: small } });
  assert.equal(noIfMatch.body.error.code, 'IF_MATCH_REQUIRED');

  const table = await freeTable(r);
  const ok = await call('POST', `/reservations/${r.id}/confirm`, { token, ifMatch: 1, body: { tableId: table.id } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'CONFIRMED');
  assert.equal(ok.body.data.table.id, table.id);

  const again = await call('POST', `/reservations/${r.id}/confirm`, { token, ifMatch: 2, body: { tableId: table.id } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'INVALID_STATE');
});

test('two staff confirming the same table and time concurrently: only one succeeds', async () => {
  const startsAt = slot();
  const a = await book({ startsAt, phone: '0909000333' });
  const b = await book({ startsAt, phone: '0909000444' });
  const table = await freeTable(a);
  const token = await as('tn.q1');

  const results = await Promise.all(
    [a, b].map((r) => call('POST', `/reservations/${r.id}/confirm`, { token, ifMatch: 1, body: { tableId: table.id } })),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify(results.map((r) => r.body)));
  assert.equal(results.find((r) => r.status === 409).body.error.code, 'TABLE_TIME_CONFLICT');

  const loser = results[0].status === 409 ? a : b;
  assert.equal((await detail(loser.id)).status, 'PENDING', 'BR012: the other booking stays PENDING');
});

test('update re-checks the table: keeps it when it still fits, moves when it does not', async () => {
  const token = await as('tn.q1');
  const r = await book({ partySize: 2 });
  const small = await freeTable(r);
  await call('POST', `/reservations/${r.id}/confirm`, { token, ifMatch: 1, body: { tableId: small.id } });

  const rename = await call('PATCH', `/reservations/${r.id}`, { token, ifMatch: 2, body: { customerName: 'Khách Đổi Tên' } });
  assert.equal(rename.status, 200, JSON.stringify(rename.body));
  assert.equal(rename.body.data.table.id, small.id);
  assert.equal(rename.body.meta.tableChanged, false);

  const bigger = await call('PATCH', `/reservations/${r.id}`, { token, ifMatch: 3, body: { partySize: 5 } });
  assert.equal(bigger.status, 200, JSON.stringify(bigger.body));
  assert.ok(bigger.body.data.table.capacity >= 5);
  assert.equal(bigger.body.meta.tableChanged, small.capacity < 5);

  const nothing = await call('PATCH', `/reservations/${r.id}`, { token, ifMatch: 4, body: { partySize: 5 } });
  assert.equal(nothing.body.error.code, 'NO_CHANGES');
  const forbiddenField = await call('PATCH', `/reservations/${r.id}`, { token, ifMatch: 4, body: { status: 'CANCELLED' } });
  assert.equal(forbiddenField.body.error.code, 'UNKNOWN_FIELD');
  const stale = await call('PATCH', `/reservations/${r.id}`, { token, ifMatch: 1, body: { partySize: 4 } });
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

  const sms = await call('GET', '/reservations/notifications?channel=SMS&limit=50', { token });
  assert.ok(sms.body.data.some((n) => n.reservationId === r.id && n.event === 'UPDATED'), 'BR020: customer is notified');
});

test('update to a slot with no suitable free table is refused and the booking is kept', async () => {
  const token = await as('tn.q1');
  const startsAt = slot();
  // Fill the 10-seat VIP room at that time, then ask another booking to grow to 10 people.
  const vip = await book({ startsAt, partySize: 10, phone: '0909000555' });
  const vipConfirm = await call('POST', `/reservations/${vip.id}/confirm`, {
    token,
    ifMatch: 1,
    body: { tableId: '70000000-0000-4000-8000-000000000105' },
  });
  assert.equal(vipConfirm.status, 200, JSON.stringify(vipConfirm.body));

  const r = await book({ startsAt, partySize: 2, phone: '0909000666' });
  await call('POST', `/reservations/${r.id}/confirm`, { token, ifMatch: 1, body: { tableId: (await freeTable(r)).id } });
  const res = await call('PATCH', `/reservations/${r.id}`, { token, ifMatch: 2, body: { partySize: 10 } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'NO_TABLE_AVAILABLE');
  assert.equal((await detail(r.id)).partySize, 2);
});

test('cancel needs a reason, frees the table, and a cancelled booking is final', async () => {
  const token = await as('tn.q1');
  const r = await book();
  const table = await freeTable(r);
  await call('POST', `/reservations/${r.id}/confirm`, { token, ifMatch: 1, body: { tableId: table.id } });

  const noReason = await call('POST', `/reservations/${r.id}/cancel`, { token, ifMatch: 2, body: { reason: '  ' } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'CANCEL_REASON_REQUIRED');

  const ok = await call('POST', `/reservations/${r.id}/cancel`, { token, ifMatch: 2, body: { reason: 'Khách báo bận việc' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'CANCELLED');
  assert.equal(ok.body.data.cancelReason, 'Khách báo bận việc');
  assert.deepEqual(ok.body.data.allowedActions, []);

  const freed = await call(
    'GET',
    `/branches/${B1}/tables/availability?startsAt=${encodeURIComponent(r.startsAt)}&partySize=${r.partySize}`,
    { token },
  );
  assert.ok(freed.body.data.tables.find((t) => t.id === table.id).available, 'table released');

  const again = await call('POST', `/reservations/${r.id}/cancel`, { token, ifMatch: ok.body.data.version, body: { reason: 'Hủy lần hai' } });
  assert.equal(again.status, 409);
  const edit = await call('PATCH', `/reservations/${r.id}`, { token, ifMatch: ok.body.data.version, body: { partySize: 3 } });
  assert.equal(edit.status, 409);
});

test('a booking whose order was already submitted is not cancelled (BR024)', async () => {
  const token = await as('tn.q1');
  const before = await detail(SEED.withSubmittedOrder);
  assert.equal(before.status, 'CONFIRMED');
  const res = await call('POST', `/reservations/${SEED.withSubmittedOrder}/cancel`, {
    token,
    ifMatch: before.version,
    body: { reason: 'Khách muốn hủy' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ORDER_LOCKED');
  const after = await detail(SEED.withSubmittedOrder);
  assert.equal(after.status, 'CONFIRMED');
  assert.equal(after.version, before.version, 'nothing changed');
});

test('table schedule shows confirmed bookings on their table and pending ones as unassigned', async () => {
  const token = await as('tn.q1');
  const startsAt = slot();
  const date = startsAt.slice(0, 10);
  const confirmed = await book({ startsAt, phone: '0909000777' });
  const table = await freeTable(confirmed);
  await call('POST', `/reservations/${confirmed.id}/confirm`, { token, ifMatch: 1, body: { tableId: table.id } });
  const pending = await book({ startsAt, phone: '0909000888' });

  const res = await call('GET', `/branches/${B1}/tables/schedule?date=${date}`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = res.body.data.tables.find((t) => t.id === table.id);
  assert.ok(row.bookings.some((b) => b.id === confirmed.id));
  assert.ok(res.body.data.unassigned.some((b) => b.id === pending.id));
  assert.ok(res.body.data.tables.every((t) => t.branchId === B1));

  const other = await call('GET', `/branches/${B2}/tables/schedule?date=${date}`, { token });
  assert.equal(other.status, 403);
  const waiter = await call('GET', `/branches/${B1}/tables/schedule`, { token: await as('pv.q1') });
  assert.equal(waiter.status, 403);
});

// Runs last: it uses up this client's remaining quota. Invalid bodies count too, so a flood of junk is blocked.
test('the public endpoint is rate limited per client', async () => {
  const body = { branchId: B1, customerName: 'Khách', phone: 'bad', startsAt: slot(), partySize: 2, serviceType: 'DINE_IN' };
  let last = await call('POST', '/reservations', { body });
  const remaining = Number(last.headers.get('ratelimit-remaining'));
  assert.ok(Number.isInteger(remaining), 'RateLimit-Remaining header');
  for (let i = 0; i <= remaining; i++) last = await call('POST', '/reservations', { body });
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, 'TOO_MANY_REQUESTS');
  assert.ok(last.headers.get('retry-after'));
});
