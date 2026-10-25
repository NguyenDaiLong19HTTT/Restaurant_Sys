import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const base = process.env.API_BASE_URL || 'http://127.0.0.1:18081';
const menu = process.env.MENU_BASE_URL || 'http://menu-service:3000';
const password = readFileSync(process.env.DEMO_PASSWORD_FILE || '.local/demo-password', 'utf8').trim();
const serviceToken = readFileSync(process.env.INTERNAL_SERVICE_TOKEN_FILE || '.local/order-menu-token', 'utf8').trim();
const tokens = {};
async function request(path, { role = 'owner', method = 'GET', body, headers = {}, direct = false } = {}) {
  const r = await fetch(`${direct ? menu : base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}), ...(method === 'DELETE' ? { 'Idempotency-Key': randomUUID() } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? null : await r.json(), headers: r.headers };
}
const prefix = '/api/v1/dishes';
const create = (name, options = {}) => request(prefix, { method: 'POST', body: { name, category: 'Kiểm thử', priceVnd: 123456, ...options.body }, ...options, headers: { 'Idempotency-Key': randomUUID(), ...options.headers } });
const name = label => `${label} ${randomUUID()}`;
before(async () => {
  for (const username of ['owner', 'server', 'reception', 'manager']) {
    const response = await request('/api/v1/auth/login', { role: 'none', method: 'POST', body: { username, password } });
    assert.equal(response.status, 200); tokens[username] = response.body.data.accessToken;
  }
});
test('missing, tampered and wrong-role tokens are rejected; development login uses password', async () => {
  assert.equal((await request(prefix, { role: 'none' })).status, 401);
  assert.equal((await request(prefix, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await request('/api/v1/auth/login', { method: 'POST', body: { username: 'owner', password: 'wrong' } })).status, 401);
  for (const role of ['server', 'reception', 'manager']) {
    assert.equal((await create(name('Forbidden'), { role })).status, 403);
    assert.equal((await request(`${prefix}/name-availability?name=A`, { role })).status, 403);
    assert.equal((await request(`${prefix}?status=DELETED`, { role })).status, 403);
  }
});
test('create unique code, detail by code/id and request tracing', async () => {
  const r = await create(name('Chi tiết'));
  assert.equal(r.status, 201); assert.match(r.body.data.code, /^DISH-/); assert.equal(r.body.data.priceVnd, 123456);
  const byCode = await request(`${prefix}/${r.body.data.code}`, { headers: { 'X-Request-Id': 'menu-integration-trace' } });
  assert.equal(byCode.body.data.id, r.body.data.id); assert.equal(byCode.headers.get('X-Request-Id'), 'menu-integration-trace');
});
test('create duplicate trimmed/case-insensitive name and availability reject', async () => {
  const n = name('Phở trùng'); assert.equal((await create(n)).status, 201);
  const r = await create(`  ${n.toUpperCase()}  `); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'DISH_NAME_EXISTS');
  assert.equal((await request(`${prefix}/name-availability?name=${encodeURIComponent(n)}`)).body.data.available, false);
});
test('two simultaneous creates with different keys: one success and one DB conflict', async () => {
  const n = name('Đồng thời');
  const responses = await Promise.all([create(n), create(` ${n.toUpperCase()} `)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal((await request(`${prefix}?q=${encodeURIComponent(n)}`)).body.meta.total, 1);
});
test('idempotent simultaneous retry returns same id, changed payload rejected', async () => {
  const n = name('Retry'), key = randomUUID();
  const responses = await Promise.all([create(n, { headers: { 'Idempotency-Key': key } }), create(n, { headers: { 'Idempotency-Key': key } })]);
  assert.deepEqual(responses.map(r => r.status), [201, 201]); assert.equal(responses[0].body.data.id, responses[1].body.data.id);
  assert.equal((await create(name('Khác'), { headers: { 'Idempotency-Key': key } })).status, 409);
});
test('invalid prices, missing fields, read-only fields and malformed JSON', async () => {
  for (const priceVnd of [0, -10, 1.5, '1000', 1000000000000]) assert.equal((await create(name('Giá'), { body: { name: name('Giá'), category: 'A', priceVnd } })).status, 422);
  assert.equal((await request(prefix, { method: 'POST', body: {}, headers: { 'Idempotency-Key': randomUUID() } })).status, 422);
  const r = await fetch(`${base}${prefix}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.owner}`, 'Content-Type': 'application/json' }, body: '{bad' }); assert.equal(r.status, 400);
});
test('update keeps code, excludes current dish; duplicate other name and stale version blocked', async () => {
  const a = (await create(name('Sửa A'))).body.data, b = (await create(name('Sửa B'))).body.data;
  assert.equal((await request(`${prefix}/name-availability?name=${encodeURIComponent(a.name)}&excludeDishId=${a.id}`)).body.data.available, true);
  const r = await request(`${prefix}/${a.id}`, { method: 'PATCH', headers: { 'If-Match': '1' }, body: { name: ` ${a.name.toUpperCase()} `, priceVnd: 999999 } });
  assert.equal(r.status, 200); assert.equal(r.body.data.code, a.code); assert.equal(r.body.data.version, 2);
  assert.equal((await request(`${prefix}/${a.id}`, { method: 'PATCH', headers: { 'If-Match': '2' }, body: { name: b.name } })).status, 409);
  assert.equal((await request(`${prefix}/${a.id}`, { method: 'PATCH', headers: { 'If-Match': '1' }, body: { priceVnd: 900 } })).body.error.code, 'VERSION_CONFLICT');
  assert.equal((await request(`${prefix}/${a.id}`, { method: 'PATCH', headers: { 'If-Match': '2' }, body: { status: 'ACTIVE' } })).status, 422);
  for (const role of ['server', 'reception', 'manager']) {
    assert.equal((await request(`${prefix}/${a.id}`, { role, method: 'PATCH', body: { name: 'X' } })).status, 403);
    assert.equal((await request(`${prefix}/${a.id}`, { role, method: 'DELETE' })).status, 403);
  }
});
test('concurrent updates enforce If-Match and cannot lose changes', async () => {
  const a = (await create(name('Phiên bản'))).body.data;
  const changes = await Promise.all([100, 200].map(priceVnd => request(`${prefix}/${a.id}`, { method: 'PATCH', headers: { 'If-Match': '1' }, body: { priceVnd } })));
  assert.deepEqual(changes.map(r => r.status).sort(), [200, 409]);
});
test('soft deletion retains record/name, hides from ordering and forbids restore', async () => {
  const a = (await create(name('Xóa mềm'))).body.data;
  const deleteKey = randomUUID();
  assert.equal((await request(`${prefix}/${a.id}`, { method: 'DELETE', headers: { 'If-Match': '1', 'Idempotency-Key': deleteKey } })).status, 204);
  assert.equal((await request(`${prefix}/${a.id}`, { method: 'DELETE', headers: { 'If-Match': '1', 'Idempotency-Key': deleteKey } })).status, 204);
  const old = await request(`${prefix}/${a.id}`); assert.equal(old.body.data.status, 'DELETED'); assert.equal(old.body.data.code, a.code);
  assert.equal((await request(`${prefix}/${a.id}`, { role: 'server' })).status, 404);
  assert.equal((await request(`${prefix}/${a.id}`, { method: 'PATCH', headers: { 'If-Match': '2' }, body: { priceVnd: 99 } })).body.error.code, 'DISH_DELETED');
  assert.equal((await create(a.name)).status, 409);
  assert.equal((await request(`${prefix}?q=${encodeURIComponent(a.name)}`, { role: 'server' })).body.meta.total, 0);
});
test('internal resolve authenticates order caller, checks all ACTIVE, never exposed via Gateway', async () => {
  const a = (await create(name('Resolve'))).body.data;
  const body = { dishIds: [a.id] }, headers = { 'X-Service-Token': serviceToken };
  assert.equal((await request('/internal/v1/dishes/resolve', { direct: true, method: 'POST', body })).status, 401);
  assert.equal((await request('/internal/v1/dishes/resolve', { method: 'POST', body, headers })).status, 404);
  const resolved = await request('/internal/v1/dishes/resolve', { direct: true, method: 'POST', body, headers });
  assert.equal(resolved.status, 200); assert.equal(resolved.body.data.dishes[0].priceVnd, a.priceVnd);
  // This models the order consumer's immutable snapshot contract; no order DB is accessed.
  const snapshot = structuredClone(resolved.body.data.dishes[0]);
  await request(`${prefix}/${a.id}`, { method: 'PATCH', headers: { 'If-Match': '1' }, body: { name: name('Tên mới'), priceVnd: 333 } });
  assert.equal(snapshot.name, a.name); assert.equal(snapshot.priceVnd, a.priceVnd);
  await request(`${prefix}/${a.id}`, { method: 'DELETE', headers: { 'If-Match': '2' } });
  const deleted = await request('/internal/v1/dishes/resolve', { direct: true, method: 'POST', body, headers });
  assert.equal(deleted.status, 422); assert.equal(deleted.body.error.code, 'DISH_UNAVAILABLE');
  assert.equal((await request('/internal/v1/dishes/resolve', { direct: true, method: 'POST', body: { dishIds: [a.id, a.id] }, headers })).status, 422);
  assert.equal(snapshot.priceVnd, a.priceVnd);
});
test('pagination, empty search and input are validated', async () => {
  assert.equal((await request(`${prefix}?page=0`)).status, 400);
  assert.equal((await request(`${prefix}?limit=101`)).status, 400);
  const r = await request(`${prefix}?limit=2`); assert.equal(r.body.data.length, 2); assert.equal(r.body.meta.limit, 2);
});
