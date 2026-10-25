import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { secret } from '../../../packages/http.mjs';
export function database() {
  if (process.env.DB_NAME !== 'menu_db') throw new Error('Menu service must own menu_db');
  return mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: secret('DB_PASSWORD_FILE'), database: 'menu_db', timezone: 'Z', charset: 'utf8mb4', connectionLimit: 10, supportBigNumbers: true });
}
export async function migrate(pool) {
  const c = await pool.getConnection();
  try {
    const [[lock]] = await c.query("SELECT GET_LOCK('menu_migration',30) AS acquired");
    if (lock.acquired !== 1) throw new Error('Migration lock unavailable');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(100) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    const sql = await readFile(new URL('../migrations/001-menu.sql', import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const [[old]] = await c.execute('SELECT checksum FROM schema_migrations WHERE id=?', ['001-menu']);
    if (old && old.checksum !== checksum) throw new Error('Applied migration changed');
    if (!old) {
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await c.query(statement);
      await c.execute('INSERT INTO schema_migrations(id,checksum) VALUES (?,?)', ['001-menu', checksum]);
    }
    if (process.env.SEED_DEMO === 'true') {
      const [[seeded]] = await c.execute('SELECT id FROM schema_migrations WHERE id=?', ['seed-demo-v1']);
      if (!seeded) {
        await c.beginTransaction();
        for (const [id, name, category, price, image, status] of [
          ['11111111-1111-4111-8111-111111111111', 'Phở bò đặc biệt', 'Món chính', 85000, '/images/pho.svg', 'ACTIVE'],
          ['22222222-2222-4222-8222-222222222222', 'Gỏi cuốn tôm thịt', 'Khai vị', 55000, '/images/goi.svg', 'ACTIVE'],
          ['33333333-3333-4333-8333-333333333333', 'Trà đào cam sả', 'Đồ uống', 39000, '/images/tra.svg', 'ACTIVE'],
          ['44444444-4444-4444-8444-444444444444', 'Bánh flan truyền thống', 'Tráng miệng', 25000, null, 'DELETED']
        ]) await c.execute('INSERT IGNORE INTO dishes(id,code,name,normalized_name,category,price_vnd,description,image_url,status) VALUES (?,?,?,?,?,?,?,?,?)', [id, `DISH-${id}`, name, name.toLowerCase(), category, price, 'Hương vị quen thuộc, chế biến mỗi ngày.', image, status]);
        await c.execute('INSERT INTO schema_migrations(id,checksum) VALUES (?,?)', ['seed-demo-v1', 'demo-v1']);
        await c.commit();
      }
    }
  } catch (err) { await c.rollback(); throw err; }
  finally { await c.query("SELECT RELEASE_LOCK('menu_migration')"); c.release(); }
}
