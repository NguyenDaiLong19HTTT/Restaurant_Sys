import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../services/menu/src/db.mjs';
test('real MySQL UNIQUE/CHECK constraints protect data even without API checks', async () => {
  const pool = database(), c = await pool.getConnection();
  const id = randomUUID(), normalized = `database-${randomUUID()}`;
  const insert = (id, name, price) => c.execute('INSERT INTO dishes(id,code,name,normalized_name,category,price_vnd) VALUES (?,?,?,?,?,?)', [id, `DISH-${id}`, 'Test direct SQL', name, 'Kiểm thử DB', price]);
  try {
    await c.beginTransaction();
    await insert(id, normalized, 50000);
    await assert.rejects(insert(randomUUID(), normalized, 50000), err => err.code === 'ER_DUP_ENTRY');
    await assert.rejects(insert(randomUUID(), `price-${randomUUID()}`, 0), err => err.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
    const [grants] = await c.query('SHOW GRANTS FOR CURRENT_USER');
    const values = grants.map(r => Object.values(r)[0].replaceAll('\\', ''));
    assert.ok(values.some(g => g.includes('`menu_db`.*')));
    assert.ok(values.every(g => g.includes('USAGE ON *.*') || g.includes('`menu_db`.*')));
  } finally { await c.rollback(); c.release(); await pool.end(); }
});
