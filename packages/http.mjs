import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { importSPKI, jwtVerify } from 'jose';
import helmet from 'helmet';

export class ApiError extends Error {
  constructor(status, code, message, details = {}) { super(message); Object.assign(this, { status, code, details }); }
}
export const secret = name => readFileSync(process.env[name], 'utf8').trim();
export function common(app) {
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    req.requestId = /^[a-zA-Z0-9_-]{1,100}$/.test(req.get('X-Request-Id') || '') ? req.get('X-Request-Id') : randomUUID();
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    next();
  });
}
export function errors(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.code === 'ER_DUP_ENTRY') err = new ApiError(409, 'DISH_NAME_EXISTS', 'Tên món đã tồn tại', { name: 'Tên món đã tồn tại' });
  if (err.type === 'entity.parse.failed') err = new ApiError(400, 'INVALID_JSON', 'JSON không hợp lệ');
  if (err.type === 'entity.too.large') err = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Dữ liệu quá lớn');
  if (!err.status) console.error(JSON.stringify({ requestId: req.requestId, code: err.code || 'UNEXPECTED_ERROR' }));
  res.status(err.status || 500).json({ error: { code: err.code || 'INTERNAL_ERROR', message: err.status ? err.message : 'Có lỗi hệ thống', details: err.details || {} }, requestId: req.requestId });
}
export function notFound(req, res, next) { next(new ApiError(404, 'NOT_FOUND', 'Không tìm thấy tài nguyên')); }
export async function authMiddleware() {
  const mode = process.env.AUTH_MODE;
  if (!['development', 'identity'].includes(mode)) throw new Error('AUTH_MODE must be development or identity');
  if (mode === 'development' && process.env.NODE_ENV === 'production') throw new Error('Development auth forbidden in production');
  if (!process.env.JWT_ISSUER || !process.env.JWT_AUDIENCE) throw new Error('JWT issuer and audience are required');
  if (mode === 'identity' && !process.env.IDENTITY_INTROSPECTION_URL) throw new Error('Identity introspection required to reject disabled/stale tokens');
  const key = await importSPKI(secret('JWT_PUBLIC_KEY_FILE'), 'RS256');
  return async (req, res, next) => {
    try {
      const token = req.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
      if (!token) throw new Error('missing');
      const { payload } = await jwtVerify(token, key, { algorithms: ['RS256'], issuer: process.env.JWT_ISSUER, audience: process.env.JWT_AUDIENCE, requiredClaims: ['exp', 'sub', 'role', 'accountId', 'tokenVersion'] });
      if (payload.tokenUse !== 'access' || payload.accountId !== payload.sub || !Number.isInteger(payload.tokenVersion) || !['CHU_CHUOI', 'NHAN_VIEN_PHUC_VU', 'NHAN_VIEN_TIEP_NHAN', 'QUAN_LY_CHI_NHANH'].includes(payload.role)) throw new Error('claims');
      if (payload.role !== 'CHU_CHUOI' && !payload.branchId) throw new Error('branch');
      if (mode === 'identity') {
        const response = await fetch(process.env.IDENTITY_INTROSPECTION_URL, { headers: { Authorization: `Bearer ${token}`, 'X-Request-Id': req.requestId }, signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error('inactive');
        const { data } = await response.json();
        if (data.id !== payload.accountId || data.status !== 'ACTIVE' || data.tokenVersion !== payload.tokenVersion || data.role !== payload.role || (data.branchId || null) !== (payload.branchId || null)) throw new Error('stale');
      }
      req.account = payload;
      next();
    } catch { next(new ApiError(401, 'UNAUTHENTICATED', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn')); }
  };
}
export const roles = (...allowed) => (req, res, next) => allowed.includes(req.account.role) ? next() : next(new ApiError(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này'));
