'use strict';

/**
 * Data-constraint and authorisation cases through the gateway (stack must be running).
 * JWT tampering cases run only when JWT_SECRET is provided (same value as deploy/.env).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const BASE = process.env.BASE_URL || 'http://localhost:8080/api/v1';
const PASSWORD = process.env.DEMO_PASSWORD || '123456';
const JWT_SECRET = process.env.JWT_SECRET;

const B1 = '11111111-1111-4111-8111-111111111111';
const GAO = 'a0000000-0000-4000-8000-000000000001';
const RAU = 'a0000000-0000-4000-8000-000000000003';
const DEMO_APPROVED = 'c0000000-0000-4000-8000-000000000003';
const OWNER_ID = 'f0000000-0000-4000-8000-000000000001';

async function call(method, path, { token, body, rawBody, contentType, ifMatch, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = contentType || 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(BASE + path, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const tokens = {};
async function as(username) {
  if (!tokens[username]) {
    const res = await call('POST', '/auth/login', { body: { username, password: PASSWORD } });
    assert.equal(res.status, 200);
    tokens[username] = res.body.data.accessToken;
  }
  return tokens[username];
}

const valid = (overrides = {}) => ({ reason: 'Bổ sung nguyên liệu', items: [{ ingredientId: GAO, quantity: '1' }], ...overrides });
const expectError = (res, status, code) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  if (code) assert.equal(res.body.error.code, code);
  assert.ok(res.body.requestId, 'error responses carry requestId');
};

// ---------------- request shape ----------------
test('rejects fields the endpoint does not accept (cannot set status/version from the client)', async () => {
  const token = await as('ql.q1');
  expectError(await call('POST', '/transfer-requests', { token, body: valid({ status: 'APPROVED' }) }), 400, 'UNKNOWN_FIELD');
  expectError(
    await call('POST', '/transfer-requests', { token, body: valid({ items: [{ ingredientId: GAO, quantity: 1, price: 5 }] }) }),
    400,
    'UNKNOWN_FIELD',
  );
});

test('rejects non-object bodies, wrong content type and malformed JSON', async () => {
  const token = await as('ql.q1');
  expectError(await call('POST', '/transfer-requests', { token, body: [valid()] }), 400, 'INVALID_BODY');
  expectError(
    await call('POST', '/transfer-requests', { token, rawBody: 'reason=x', contentType: 'text/plain' }),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
  );
  expectError(await call('POST', '/transfer-requests', { token, rawBody: '{"reason":' }), 400, 'INVALID_JSON');
});

test('validates path and query parameters', async () => {
  const token = await as('chuchuoi');
  expectError(await call('GET', '/transfer-requests/not%20an%20id!', { token }), 400, 'INVALID_ID');
  expectError(await call('GET', '/transfer-requests?status=DONE', { token }), 400, 'VALIDATION_ERROR');
  expectError(await call('GET', '/transfer-requests?limit=1000', { token }), 400, 'VALIDATION_ERROR');
  expectError(await call('GET', `/branches/${B1}/stock?warehouseId=@@`, { token }), 400, 'VALIDATION_ERROR');
  expectError(await call('GET', '/branches/99999999-9999-4999-8999-999999999999/stock', { token }), 404, 'BRANCH_NOT_FOUND');
});

// ---------------- business field rules ----------------
test('reason must be 5–500 characters', async () => {
  const token = await as('ql.q1');
  expectError(await call('POST', '/transfer-requests', { token, body: valid({ reason: 'abc' }) }), 400);
  expectError(await call('POST', '/transfer-requests', { token, body: valid({ reason: 'a'.repeat(501) }) }), 400);
});

test('quantity must be > 0, ≤ 1,000,000 with at most 3 decimals; notes ≤ 255', async () => {
  const token = await as('ql.q1');
  for (const quantity of ['1000000.001', '1.2345', '-2', 'abc', '']) {
    expectError(
      await call('POST', '/transfer-requests', { token, body: valid({ items: [{ ingredientId: GAO, quantity }] }) }),
      400,
      'INVALID_QUANTITY',
    );
  }
  expectError(
    await call('POST', '/transfer-requests', { token, body: valid({ items: [{ ingredientId: GAO, quantity: 1, note: 'n'.repeat(256) }] }) }),
    400,
  );
});

test('rejects unknown ingredients and more than 50 lines', async () => {
  const token = await as('ql.q1');
  expectError(
    await call('POST', '/transfer-requests', {
      token,
      body: valid({ items: [{ ingredientId: 'a0000000-0000-4000-8000-0000000000ff', quantity: 1 }] }),
    }),
    422,
    'INGREDIENT_NOT_FOUND',
  );
  const many = Array.from({ length: 51 }, (_, i) => ({ ingredientId: `id-${i}`, quantity: 1 }));
  expectError(await call('POST', '/transfer-requests', { token, body: valid({ items: many }) }), 400);
});

// ---------------- authorisation ----------------
test('role permissions: owner cannot create/confirm, manager cannot approve', async () => {
  const owner = await as('chuchuoi');
  const manager = await as('ql.q1');
  expectError(await call('POST', '/transfer-requests', { token: owner, body: valid() }), 403, 'ROLE_FORBIDDEN');
  expectError(
    await call('POST', '/export-slips/e0000000-0000-4000-8000-000000000001/confirm', { token: owner, ifMatch: 1, key: 'k-owner-1' }),
    403,
    'ROLE_FORBIDDEN',
  );
  expectError(
    await call('POST', `/transfer-requests/${DEMO_APPROVED}/approve`, {
      token: manager,
      ifMatch: 1,
      body: { supplierBranchId: B1, warehouseId: 'x' },
    }),
    403,
    'ROLE_FORBIDDEN',
  );
  expectError(await call('GET', `/transfer-requests/${DEMO_APPROVED}/eligible-branches`, { token: manager }), 403);
});

test('branch scope: supplier manager can view but not edit; unrelated manager cannot view', async () => {
  const supplier = await as('ql.td'); // DP-DEMO-0003: Bình Thạnh requests, Thủ Đức supplies
  const view = await call('GET', `/transfer-requests/${DEMO_APPROVED}`, { token: supplier });
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.data.allowedActions, []);
  expectError(
    await call('PATCH', `/transfer-requests/${DEMO_APPROVED}`, { token: supplier, ifMatch: view.body.data.version, body: { reason: 'Sửa trái phép' } }),
    403,
    'BRANCH_SCOPE_FORBIDDEN',
  );
  expectError(await call('GET', `/transfer-requests/${DEMO_APPROVED}`, { token: await as('ql.q1') }), 403, 'BRANCH_SCOPE_FORBIDDEN');
});

test('allowedActions reflect role, branch and status for each viewer', async () => {
  const created = await call('POST', '/transfer-requests', { token: await as('ql.q1'), body: valid({ items: [{ ingredientId: RAU, quantity: 1 }] }) });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.deepEqual(created.body.data.allowedActions.sort(), ['DELETE', 'EDIT']);

  const ownerView = await call('GET', `/transfer-requests/${id}`, { token: await as('chuchuoi') });
  assert.deepEqual(ownerView.body.data.allowedActions.sort(), ['APPROVE', 'REJECT']);

  const exportsTd = await call('GET', '/export-slips?status=PENDING', { token: await as('ql.td') });
  assert.ok(exportsTd.body.data.every((s) => s.allowedActions.includes('CONFIRM')));
  const exportsOwner = await call('GET', '/export-slips?status=PENDING', { token: await as('chuchuoi') });
  assert.ok(exportsOwner.body.data.every((s) => s.allowedActions.length === 0));

  await call('DELETE', `/transfer-requests/${id}`, { token: await as('ql.q1'), ifMatch: created.body.data.version });
});

test('audit log records who did what, in order', async () => {
  const manager = await as('ql.q1');
  const created = await call('POST', '/transfer-requests', { token: manager, body: valid() });
  const updated = await call('PATCH', `/transfer-requests/${created.body.data.id}`, {
    token: manager,
    ifMatch: created.body.data.version,
    body: { reason: 'Đổi lý do điều phối' },
  });
  const rejected = await call('POST', `/transfer-requests/${created.body.data.id}/reject`, {
    token: await as('chuchuoi'),
    ifMatch: updated.body.data.version,
    body: { reason: 'Đã đủ hàng tại chi nhánh' },
  });
  assert.equal(rejected.status, 200);
  const history = rejected.body.data.history;
  assert.deepEqual(history.map((h) => h.action), ['CREATED', 'UPDATED', 'REJECTED']);
  assert.equal(history[0].actorRole, 'QUAN_LY_CHI_NHANH');
  assert.equal(history[0].actorBranchId, B1);
  assert.equal(history[2].actorRole, 'CHU_CHUOI');
  assert.equal(history[2].details.reason, 'Đã đủ hàng tại chi nhánh');
});

test('token checks: expiry required, issuer/audience/signature verified', { skip: !JWT_SECRET && 'set JWT_SECRET to run' }, async () => {
  const claims = { accountId: OWNER_ID, role: 'CHU_CHUOI', branchId: null, tokenVersion: 1 };
  const sign = (payload, opts = {}) =>
    jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', issuer: 'identity-service', audience: 'restaurant-app', ...opts });

  assert.equal((await call('GET', '/ingredients', { token: sign(claims, { expiresIn: '5m' }) })).status, 200);
  expectError(await call('GET', '/ingredients', { token: sign(claims) }), 401); // no exp
  expectError(await call('GET', '/ingredients', { token: sign(claims, { expiresIn: '5m', issuer: 'evil' }) }), 401);
  expectError(await call('GET', '/ingredients', { token: sign(claims, { expiresIn: '5m', audience: 'other-app' }) }), 401);
  expectError(await call('GET', '/ingredients', { token: sign(claims, { expiresIn: '-1m' }) }), 401);
  expectError(await call('GET', '/ingredients', { token: sign({ ...claims, role: 'ADMIN' }, { expiresIn: '5m' }) }), 401);
  const forged = jwt.sign({ ...claims }, 'not-the-secret', { expiresIn: '5m', issuer: 'identity-service', audience: 'restaurant-app' });
  expectError(await call('GET', '/ingredients', { token: forged }), 401);
  const managerNoBranch = sign({ ...claims, role: 'QUAN_LY_CHI_NHANH' }, { expiresIn: '5m' });
  expectError(await call('GET', '/ingredients', { token: managerNoBranch }), 401);
});
