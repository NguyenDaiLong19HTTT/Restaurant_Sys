import test from 'node:test';
import assert from 'node:assert/strict';
import { dishInput, normalizeName, validImageUrl, version } from '../services/menu/src/validation.mjs';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { mkdirSync, writeFileSync } from 'node:fs';
import { authMiddleware } from '../packages/http.mjs';
test('normalize trims, ignores case and normalizes Vietnamese Unicode without removing accents', () => {
  assert.equal(normalizeName('  PHỞ BÒ  '), normalizeName('Phở bò'.normalize('NFD')));
  assert.notEqual(normalizeName('Pho bo'), normalizeName('Phở bò'));
});
test('integer VND only; required fields and upper bound', () => {
  for (const priceVnd of [0, -1, 0.5, '1000', null, NaN, Infinity, 1e15]) assert.throws(() => dishInput({ name: 'A', category: 'B', priceVnd }), e => Boolean(e.details.priceVnd));
  assert.throws(() => dishInput({}), e => Object.keys(e.details).length === 3);
  assert.equal(dishInput({ name: ' A ', category: ' B ', priceVnd: 999999999999 }).priceVnd, 999999999999);
});
test('partial update cannot modify code, status, id or restore deleted dishes', () => {
  for (const key of ['id', 'code', 'status', 'version']) assert.throws(() => dishInput({ [key]: 'ACTIVE' }, true), e => Boolean(e.details[key]));
  assert.deepEqual(dishInput({ description: '' }, true), { description: null });
});
test('image URLs are optional and reject active content/traversal', () => {
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,hi', '//host/img', '/images/../secret', 'file:///etc/passwd', 'https://user:pass@host/img']) assert.equal(validImageUrl(url), false);
  assert.equal(validImageUrl('/images/pho.svg'), true);
  assert.equal(validImageUrl('https://example.com/a.jpg'), true);
});
test('If-Match must use a positive safe version', () => {
  assert.equal(version({ get: () => '"12"' }), 12);
  for (const value of [undefined, '0', '*', 'W/"1"', '999999999999999999']) assert.throws(() => version({ get: () => value }));
});
test('JWT verifies signature, expiry, issuer/audience and access token type; mock blocked in production', async () => {
  const old = { ...process.env };
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/unit-public.pem', await exportSPKI(publicKey));
  Object.assign(process.env, { AUTH_MODE: 'development', NODE_ENV: 'test', JWT_PUBLIC_KEY_FILE: 'test-results/unit-public.pem', JWT_ISSUER: 'test-issuer', JWT_AUDIENCE: 'test-api' });
  const make = async (claims = {}, issuer = 'test-issuer', expiration = '5m') => new SignJWT({ accountId: 'a', role: 'CHU_CHUOI', branchId: null, tokenVersion: 1, tokenUse: 'access', ...claims }).setProtectedHeader({ alg: 'RS256' }).setSubject('a').setIssuer(issuer).setAudience('test-api').setExpirationTime(expiration).sign(privateKey);
  const invoke = async (middleware, token) => { let error; const req = { get: () => `Bearer ${token}`, requestId: 'unit-auth' }; await middleware(req, {}, err => { error = err; }); return { error, req }; };
  try {
    const auth = await authMiddleware();
    assert.equal((await invoke(auth, await make())).req.account.role, 'CHU_CHUOI');
    for (const jwt of [await make({ tokenUse: 'refresh' }), await make({}, 'wrong-issuer'), await make({}, 'test-issuer', '-1s'), await make({ role: 'NHAN_VIEN_PHUC_VU', branchId: null }), 'invalid.jwt.value']) assert.equal((await invoke(auth, jwt)).error.status, 401);
    process.env.NODE_ENV = 'production'; await assert.rejects(authMiddleware(), /Development auth forbidden/);
    process.env.AUTH_MODE = 'identity'; delete process.env.IDENTITY_INTROSPECTION_URL; await assert.rejects(authMiddleware(), /introspection required/);
    process.env.IDENTITY_INTROSPECTION_URL = 'http://identity.test/auth/me';
    const identityAuth = await authMiddleware(), token = await make();
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { id: 'a', role: 'CHU_CHUOI', branchId: null, tokenVersion: 1, status: 'ACTIVE' } }) });
      assert.equal((await invoke(identityAuth, token)).error, undefined);
      for (const change of [{ status: 'DISABLED' }, { tokenVersion: 2 }, { role: 'NHAN_VIEN_PHUC_VU' }]) {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { id: 'a', role: 'CHU_CHUOI', branchId: null, tokenVersion: 1, status: 'ACTIVE', ...change } }) });
        assert.equal((await invoke(identityAuth, token)).error.status, 401);
      }
      globalThis.fetch = async () => { throw new Error('timeout'); }; assert.equal((await invoke(identityAuth, token)).error.status, 401);
    } finally { globalThis.fetch = oldFetch; }
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in old)) delete process.env[name];
    Object.assign(process.env, old);
  }
});
