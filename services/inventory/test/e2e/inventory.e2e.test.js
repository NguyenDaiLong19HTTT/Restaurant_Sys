'use strict';

/**
 * Integration tests through the gateway against the running Docker stack (MySQL + real service).
 *   docker compose -f deploy/compose.yaml up -d --build
 *   BASE_URL=http://localhost:8080/api/v1 npm run test:e2e
 * Tests change stock; reset with `docker compose -f deploy/compose.yaml down -v` afterwards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const BASE = process.env.BASE_URL || 'http://localhost:8080/api/v1';
const PASSWORD = process.env.DEMO_PASSWORD || '123456';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';
const ING = {
  GAO: 'a0000000-0000-4000-8000-000000000001',
  BO: 'a0000000-0000-4000-8000-000000000002',
  RAU: 'a0000000-0000-4000-8000-000000000003',
  TRUNG: 'a0000000-0000-4000-8000-000000000005',
};
const WH = {
  Q1: 'b0000000-0000-4000-8000-000000000001',
  TD: 'b0000000-0000-4000-8000-000000000002',
};

async function call(method, path, { token, body, ifMatch, key } = {}) {
  const headers = { Accept: 'application/json' };
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

async function balance(token, branchId, warehouseId, ingredientId) {
  const res = await call('GET', `/branches/${branchId}/stock?warehouseId=${warehouseId}`, { token });
  assert.equal(res.status, 200);
  return Number(res.body.data.balances.find((b) => b.ingredientId === ingredientId).quantity);
}

async function createRequest(username, items, reason = 'e2e test') {
  const res = await call('POST', '/transfer-requests', { token: await as(username), body: { reason, items } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test('rejects requests without a token with the standard error shape', async () => {
  const res = await call('GET', '/ingredients');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  assert.ok(res.body.requestId);
});

test('service enforces role even if the UI hides the menu', async () => {
  const res = await call('GET', '/ingredients', { token: await as('pv.q1') });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ROLE_FORBIDDEN');
});

test('branch manager cannot read another branch; owner can', async () => {
  const denied = await call('GET', `/branches/${B2}/stock`, { token: await as('ql.q1') });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'BRANCH_SCOPE_FORBIDDEN');

  const owner = await call('GET', `/branches/${B2}/stock`, { token: await as('chuchuoi') });
  assert.equal(owner.status, 200);
  assert.ok(owner.body.data.warehouses.length >= 1);

  const list = await call('GET', `/transfer-requests?branchId=${B2}`, { token: await as('ql.q1') });
  assert.equal(list.status, 403);
});

test('create validates empty list, duplicates, quantity and branch from token', async () => {
  const token = await as('ql.q1');
  const empty = await call('POST', '/transfer-requests', { token, body: { reason: 'Thiếu hàng gấp', items: [] } });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, 'EMPTY_ITEMS');

  const dup = await call('POST', '/transfer-requests', {
    token,
    body: { reason: 'Thiếu hàng gấp', items: [{ ingredientId: ING.GAO, quantity: 1 }, { ingredientId: ING.GAO, quantity: 2 }] },
  });
  assert.equal(dup.status, 422);
  assert.equal(dup.body.error.code, 'DUPLICATE_INGREDIENT');

  const zero = await call('POST', '/transfer-requests', {
    token,
    body: { reason: 'Thiếu hàng gấp', items: [{ ingredientId: ING.GAO, quantity: 0 }] },
  });
  assert.equal(zero.status, 400);

  const otherBranch = await call('POST', '/transfer-requests', {
    token,
    body: { branchId: B2, reason: 'Thiếu hàng gấp', items: [{ ingredientId: ING.GAO, quantity: 1 }] },
  });
  assert.equal(otherBranch.status, 403);

  const owner = await call('POST', '/transfer-requests', {
    token: await as('chuchuoi'),
    body: { reason: 'Thiếu hàng gấp', items: [{ ingredientId: ING.GAO, quantity: 1 }] },
  });
  assert.equal(owner.status, 403);
});

test('create with the same Idempotency-Key returns the same request', async () => {
  const token = await as('ql.q1');
  const key = crypto.randomUUID();
  const body = { reason: 'idempotent create', items: [{ ingredientId: ING.RAU, quantity: '0.5' }] };
  const first = await call('POST', '/transfer-requests', { token, body, key });
  const second = await call('POST', '/transfer-requests', { token, body, key });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.data.id, first.body.data.id);
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  await call('DELETE', `/transfer-requests/${first.body.data.id}`, { token, ifMatch: first.body.data.version });
});

test('pending request can be edited and deleted only with the current version', async () => {
  const token = await as('ql.q1');
  const created = await createRequest('ql.q1', [{ ingredientId: ING.GAO, quantity: '2' }]);

  const stale = await call('PATCH', `/transfer-requests/${created.id}`, {
    token,
    ifMatch: created.version + 5,
    body: { reason: 'stale' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');

  const noIfMatch = await call('PATCH', `/transfer-requests/${created.id}`, { token, body: { reason: 'Thiếu hàng gấp' } });
  assert.equal(noIfMatch.status, 400);

  const updated = await call('PATCH', `/transfer-requests/${created.id}`, {
    token,
    ifMatch: created.version,
    body: { reason: 'đã sửa', items: [{ ingredientId: ING.BO, quantity: '1.25' }] },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.version, created.version + 1);
  assert.equal(updated.body.data.items[0].quantity, '1.25');

  const otherManager = await call('DELETE', `/transfer-requests/${created.id}`, {
    token: await as('ql.td'),
    ifMatch: updated.body.data.version,
  });
  assert.equal(otherManager.status, 403);

  const del = await call('DELETE', `/transfer-requests/${created.id}`, { token, ifMatch: updated.body.data.version });
  assert.equal(del.status, 204);
  const gone = await call('GET', `/transfer-requests/${created.id}`, { token });
  assert.equal(gone.status, 404);
});

test('reject requires a reason and locks the request', async () => {
  const owner = await as('chuchuoi');
  const created = await createRequest('ql.q1', [{ ingredientId: ING.TRUNG, quantity: 5 }]);
  const noReason = await call('POST', `/transfer-requests/${created.id}/reject`, {
    token: owner,
    ifMatch: created.version,
    body: { reason: '  ' },
  });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'REJECTION_REASON_REQUIRED');

  const rejected = await call('POST', `/transfer-requests/${created.id}/reject`, {
    token: owner,
    ifMatch: created.version,
    body: { reason: 'Không cần thiết' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.status, 'REJECTED');

  const edit = await call('PATCH', `/transfer-requests/${created.id}`, {
    token: await as('ql.q1'),
    ifMatch: rejected.body.data.version,
    body: { reason: 'Thiếu hàng gấp' },
  });
  assert.equal(edit.status, 409);
});

test('full flow: approve -> concurrent export deducts once -> import is idempotent', async () => {
  const owner = await as('chuchuoi');
  const supplier = await as('ql.td');
  const receiver = await as('ql.q1');

  const created = await createRequest('ql.q1', [
    { ingredientId: ING.RAU, quantity: '1.5' },
    { ingredientId: ING.TRUNG, quantity: 10 },
  ]);
  assert.equal(created.status, 'PENDING_APPROVAL');

  // Eligibility lists Thủ Đức "kho tổng" as able to supply the full list.
  const eligible = await call('GET', `/transfer-requests/${created.id}/eligible-branches`, { token: owner });
  assert.equal(eligible.status, 200);
  const td = eligible.body.data.branches.find((b) => b.branchId === B2);
  assert.ok(td.warehouses.find((w) => w.warehouseId === WH.TD).eligible);

  const managerEligible = await call('GET', `/transfer-requests/${created.id}/eligible-branches`, { token: receiver });
  assert.equal(managerEligible.status, 403);

  const sameBranch = await call('POST', `/transfer-requests/${created.id}/approve`, {
    token: owner,
    ifMatch: created.version,
    body: { supplierBranchId: B1, warehouseId: WH.Q1 },
  });
  assert.equal(sameBranch.status, 422);

  const approved = await call('POST', `/transfer-requests/${created.id}/approve`, {
    token: owner,
    ifMatch: created.version,
    body: { supplierBranchId: B2, warehouseId: WH.TD },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.status, 'APPROVED');
  const exportSlip = approved.body.data.exportSlip;
  assert.equal(exportSlip.status, 'PENDING');

  const afterApproveEdit = await call('PATCH', `/transfer-requests/${created.id}`, {
    token: receiver,
    ifMatch: approved.body.data.version,
    body: { reason: 'Thiếu hàng gấp' },
  });
  assert.equal(afterApproveEdit.status, 409);

  // Requesting branch cannot confirm the supplier's export slip.
  const wrongManager = await call('POST', `/export-slips/${exportSlip.id}/confirm`, {
    token: receiver,
    ifMatch: exportSlip.version,
    key: crypto.randomUUID(),
  });
  assert.equal(wrongManager.status, 403);

  const rauBefore = await balance(supplier, B2, WH.TD, ING.RAU);
  const trungBefore = await balance(supplier, B2, WH.TD, ING.TRUNG);

  // Two managers click "confirm export" at the same time with different keys.
  const [a, b] = await Promise.all([
    call('POST', `/export-slips/${exportSlip.id}/confirm`, { token: supplier, ifMatch: exportSlip.version, key: crypto.randomUUID() }),
    call('POST', `/export-slips/${exportSlip.id}/confirm`, { token: supplier, ifMatch: exportSlip.version, key: crypto.randomUUID() }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `got ${a.status}/${b.status}`);

  assert.equal(await balance(supplier, B2, WH.TD, ING.RAU), rauBefore - 1.5);
  assert.equal(await balance(supplier, B2, WH.TD, ING.TRUNG), trungBefore - 10);

  const detail = await call('GET', `/transfer-requests/${created.id}`, { token: receiver });
  assert.equal(detail.body.data.status, 'EXPORTED');
  const importSlip = detail.body.data.importSlip;
  assert.equal(importSlip.status, 'PENDING');
  assert.equal(importSlip.branchId, B1);

  const rauQ1Before = await balance(receiver, B1, WH.Q1, ING.RAU);
  const key = crypto.randomUUID();
  const first = await call('POST', `/import-slips/${importSlip.id}/confirm`, {
    token: receiver,
    ifMatch: importSlip.version,
    key,
    body: { warehouseId: WH.Q1 },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const replay = await call('POST', `/import-slips/${importSlip.id}/confirm`, {
    token: receiver,
    ifMatch: importSlip.version,
    key,
    body: { warehouseId: WH.Q1 },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');

  const again = await call('POST', `/import-slips/${importSlip.id}/confirm`, {
    token: receiver,
    ifMatch: importSlip.version,
    key: crypto.randomUUID(),
    body: { warehouseId: WH.Q1 },
  });
  assert.equal(again.status, 409);

  assert.equal(await balance(receiver, B1, WH.Q1, ING.RAU), rauQ1Before + 1.5);
  const done = await call('GET', `/transfer-requests/${created.id}`, { token: receiver });
  assert.equal(done.body.data.status, 'IMPORTED');
});

test('export re-checks stock: nothing is deducted when it became insufficient after approval', async () => {
  const owner = await as('chuchuoi');
  const supplier = await as('ql.td');
  const available = await balance(owner, B2, WH.TD, ING.GAO);
  const portion = (Math.floor(available * 0.6 * 1000) / 1000).toFixed(3);

  // Both requests fit on their own at approval time, but not together.
  const first = await createRequest('ql.bt', [{ ingredientId: ING.GAO, quantity: portion }]);
  const second = await createRequest('ql.bt', [{ ingredientId: ING.GAO, quantity: portion }]);
  const approve = (r) =>
    call('POST', `/transfer-requests/${r.id}/approve`, {
      token: owner,
      ifMatch: r.version,
      body: { supplierBranchId: B2, warehouseId: WH.TD },
    });
  const a1 = await approve(first);
  const a2 = await approve(second);
  assert.equal(a1.status, 200);
  assert.equal(a2.status, 200);

  const ok = await call('POST', `/export-slips/${a1.body.data.exportSlip.id}/confirm`, {
    token: supplier,
    ifMatch: 1,
    key: crypto.randomUUID(),
  });
  assert.equal(ok.status, 200);
  const afterFirst = await balance(owner, B2, WH.TD, ING.GAO);

  const short = await call('POST', `/export-slips/${a2.body.data.exportSlip.id}/confirm`, {
    token: supplier,
    ifMatch: 1,
    key: crypto.randomUUID(),
  });
  assert.equal(short.status, 409);
  assert.equal(short.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(short.body.error.details.shortages.length, 1);
  assert.equal(await balance(owner, B2, WH.TD, ING.GAO), afterFirst);

  const still = await call('GET', `/transfer-requests/${second.id}`, { token: owner });
  assert.equal(still.body.data.status, 'APPROVED');
  assert.equal(still.body.data.exportSlip.status, 'PENDING');
});
