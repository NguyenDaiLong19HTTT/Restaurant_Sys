import express from 'express';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, common, authMiddleware, roles, errors, notFound, secret } from '../../../packages/http.mjs';
import { dishInput, normalizeName, version } from './validation.mjs';

const owner = roles('CHU_CHUOI');
const readers = roles('CHU_CHUOI', 'NHAN_VIEN_PHUC_VU', 'NHAN_VIEN_TIEP_NHAN', 'QUAN_LY_CHI_NHANH');
const digest = value => createHash('sha256').update(value).digest('hex');
const view = row => ({ id: row.id, code: row.code, name: row.name, category: row.category, priceVnd: Number(row.price_vnd), description: row.description, imageUrl: row.image_url, status: row.status, version: row.version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() });
async function find(db, id, lock = false) {
  const [[row]] = await db.execute(`SELECT * FROM dishes WHERE id=? OR code=?${lock ? ' FOR UPDATE' : ''}`, [id, id]);
  if (!row) throw new ApiError(404, 'DISH_NOT_FOUND', 'Không tìm thấy món ăn');
  return row;
}
async function unique(db, name, id = '') {
  const [[row]] = await db.execute('SELECT id FROM dishes WHERE normalized_name=? AND id<>? LIMIT 1', [normalizeName(name), id]);
  if (row) throw new ApiError(409, 'DISH_NAME_EXISTS', 'Tên món đã tồn tại', { name: 'Tên món đã tồn tại' });
}
export async function createApp(pool) {
  const app = express();
  common(app);
  app.use(express.json({ limit: '32kb' }));
  app.get('/health/live', (req, res) => res.json({ data: { status: 'UP' } }));
  app.get('/health/ready', async (req, res, next) => { try { await pool.query('SELECT 1'); res.json({ data: { status: 'READY' } }); } catch { next(new ApiError(503, 'DATABASE_UNAVAILABLE', 'Cơ sở dữ liệu chưa sẵn sàng')); } });
  const serviceToken = secret('INTERNAL_SERVICE_TOKEN_FILE');
  if (serviceToken.length < 32) throw new Error('Service token must have at least 32 characters');
  app.post('/internal/v1/dishes/resolve', async (req, res) => {
    const input = req.get('X-Service-Token') || '';
    const a = Buffer.from(digest(input)), b = Buffer.from(digest(serviceToken));
    if (!timingSafeEqual(a, b)) throw new ApiError(401, 'SERVICE_UNAUTHENTICATED', 'Yêu cầu xác thực order-service');
    const ids = req.body?.dishIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) || new Set(ids).size !== ids.length) throw new ApiError(422, 'INVALID_DISH_IDS', 'dishIds cần 1–100 UUID khác nhau');
    const [rows] = await pool.execute(`SELECT * FROM dishes WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    if (rows.length !== ids.length || rows.some(r => r.status !== 'ACTIVE')) throw new ApiError(422, 'DISH_UNAVAILABLE', 'Một hoặc nhiều món không còn được bán');
    const indexed = new Map(rows.map(r => [r.id, r]));
    res.json({ data: { dishes: ids.map(id => { const r = indexed.get(id); return { id: r.id, code: r.code, name: r.name, priceVnd: Number(r.price_vnd), status: r.status }; }) } });
  });
  app.use('/api/v1/dishes', await authMiddleware(), readers);
  // Static route must precede /:id.
  app.get('/api/v1/dishes/name-availability', owner, async (req, res) => {
    if (typeof req.query.name !== 'string' || !req.query.name.trim() || [...req.query.name.trim()].length > 200 || (req.query.excludeDishId !== undefined && typeof req.query.excludeDishId !== 'string')) throw new ApiError(422, 'INVALID_NAME', 'Tên món bắt buộc, tối đa 200 ký tự', { name: 'Tên món không hợp lệ' });
    const [[row]] = await pool.execute('SELECT id FROM dishes WHERE normalized_name=? AND id<>? LIMIT 1', [normalizeName(req.query.name), req.query.excludeDishId || '']);
    res.json({ data: { available: !row } });
  });
  app.get('/api/v1/dishes', async (req, res) => {
    const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? 20);
    if (!Number.isInteger(page) || page < 1 || page > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'INVALID_PAGINATION', 'page từ 1; limit từ 1 đến 100');
    let status = req.query.status || 'ACTIVE';
    if (req.account.role !== 'CHU_CHUOI') {
      if (status !== 'ACTIVE') throw new ApiError(403, 'FORBIDDEN', 'Chỉ được xem món đang bán');
      status = 'ACTIVE';
    }
    if (!['ACTIVE', 'DELETED', 'ALL'].includes(status)) throw new ApiError(400, 'INVALID_STATUS', 'Trạng thái không hợp lệ');
    const terms = [], args = [];
    if (status !== 'ALL') { terms.push('status=?'); args.push(status); }
    if (req.query.q !== undefined) {
      if (typeof req.query.q !== 'string' || req.query.q.length > 200) throw new ApiError(400, 'INVALID_SEARCH', 'Từ khóa quá dài');
      terms.push('(LOCATE(?,normalized_name)>0 OR LOCATE(?,CONVERT(code USING utf8mb4))>0)'); args.push(normalizeName(req.query.q), req.query.q.trim());
    }
    const where = terms.length ? ` WHERE ${terms.join(' AND ')}` : '';
    const [[count]] = await pool.execute(`SELECT COUNT(*) AS total FROM dishes${where}`, args);
    const [rows] = await pool.query(`SELECT * FROM dishes${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`, [...args, limit, (page - 1) * limit]);
    res.json({ data: rows.map(view), meta: { page, limit, total: Number(count.total) } });
  });
  app.get('/api/v1/dishes/:id', async (req, res) => {
    const row = await find(pool, req.params.id);
    if (req.account.role !== 'CHU_CHUOI' && row.status !== 'ACTIVE') throw new ApiError(404, 'DISH_NOT_FOUND', 'Không tìm thấy món ăn');
    res.set('ETag', `"${row.version}"`).json({ data: view(row) });
  });
  app.post('/api/v1/dishes', owner, async (req, res) => {
    const input = dishInput(req.body);
    const key = req.get('Idempotency-Key');
    if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Cần Idempotency-Key gồm 8–128 ký tự');
    const scope = digest(`${req.account.accountId}:create-dish:${key}`), hash = digest(JSON.stringify(input));
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute('INSERT INTO idempotency_keys(scope_key,request_hash) VALUES (?,?) ON DUPLICATE KEY UPDATE scope_key=scope_key', [scope, hash]);
      const [[saved]] = await c.execute('SELECT * FROM idempotency_keys WHERE scope_key=? FOR UPDATE', [scope]);
      if (saved.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key đã dùng cho nội dung khác');
      if (saved.response_json) {
        await c.commit();
        return res.status(201).json(typeof saved.response_json === 'string' ? JSON.parse(saved.response_json) : saved.response_json);
      }
      await unique(c, input.name);
      const id = randomUUID(), code = `DISH-${id}`;
      await c.execute('INSERT INTO dishes(id,code,name,normalized_name,category,price_vnd,description,image_url) VALUES (?,?,?,?,?,?,?,?)', [id, code, input.name, normalizeName(input.name), input.category, input.priceVnd, input.description, input.imageUrl]);
      const body = { data: view(await find(c, id)) };
      await c.execute('UPDATE idempotency_keys SET response_json=? WHERE scope_key=?', [JSON.stringify(body), scope]);
      await c.commit();
      res.status(201).location(`/api/v1/dishes/${id}`).json(body);
    } catch (err) { await c.rollback(); throw err; } finally { c.release(); }
  });
  async function change(req, res, deleting) {
    const expected = version(req);
    const input = deleting ? {} : dishInput(req.body, true);
    const key = req.get('Idempotency-Key');
    if (deleting && (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Cần Idempotency-Key gồm 8–128 ký tự');
    const scope = deleting ? digest(`${req.account.accountId}:delete-dish:${key}`) : null;
    const hash = digest(JSON.stringify({ id: req.params.id, expected }));
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      if (deleting) {
        await c.execute('INSERT INTO idempotency_keys(scope_key,request_hash) VALUES (?,?) ON DUPLICATE KEY UPDATE scope_key=scope_key', [scope, hash]);
        const [[saved]] = await c.execute('SELECT * FROM idempotency_keys WHERE scope_key=? FOR UPDATE', [scope]);
        if (saved.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key đã dùng cho nội dung khác');
        if (saved.response_json) { await c.commit(); return res.status(204).end(); }
      }
      const row = await find(c, req.params.id, true);
      if (row.version !== expected) throw new ApiError(409, 'VERSION_CONFLICT', 'Món đã thay đổi. Hãy tải lại trước khi lưu.');
      if (row.status === 'DELETED') throw new ApiError(409, 'DISH_DELETED', 'Món đã xóa không thể cập nhật hoặc khôi phục');
      if (deleting) await c.execute("UPDATE dishes SET status='DELETED',version=version+1 WHERE id=?", [row.id]);
      else {
        if (input.name) await unique(c, input.name, row.id);
        const updated = { ...view(row), ...input };
        await c.execute('UPDATE dishes SET name=?,normalized_name=?,category=?,price_vnd=?,description=?,image_url=?,version=version+1 WHERE id=?', [updated.name, normalizeName(updated.name), updated.category, updated.priceVnd, updated.description, updated.imageUrl, row.id]);
      }
      const result = deleting ? null : view(await find(c, row.id));
      if (deleting) await c.execute('UPDATE idempotency_keys SET response_json=? WHERE scope_key=?', ['{"status":204}', scope]);
      await c.commit();
      if (deleting) res.status(204).end(); else res.set('ETag', `"${result.version}"`).json({ data: result });
    } catch (err) { await c.rollback(); throw err; } finally { c.release(); }
  }
  app.patch('/api/v1/dishes/:id', owner, (req, res) => change(req, res, false));
  app.delete('/api/v1/dishes/:id', owner, (req, res) => change(req, res, true));
  app.use(notFound);
  app.use(errors);
  return app;
}
