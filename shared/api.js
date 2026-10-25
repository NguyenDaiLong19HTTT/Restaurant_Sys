import express from 'express';

export const app = () => {
  const server = express();
  server.use(express.json({limit: '32kb'}));
  server.use((req, _res, next) => { req.body ||= {}; next(); });
  server.get('/health', (_req, res) => res.json({ok: true}));
  return server;
};
export const fail = (status, message) => Object.assign(new Error(message), {status});
export const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
export function errors(server) {
  server.use((error, _req, res, _next) => {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({error: 'Thông tin đã tồn tại'});
    if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({error: 'Dữ liệu tham chiếu không tồn tại'});
    if (!error.status) console.error('HR request failed',error.code||'UNEXPECTED');
    res.status(error.status || 500).json({error: error.status ? error.message : 'Lỗi hệ thống'});
  });
}
export function internal(req, _res, next) {
  if (!process.env.INTERNAL_API_KEY || req.get('X-Service-Token') !== process.env.INTERNAL_API_KEY) return next(fail(403, 'Internal key không hợp lệ'));
  next();
}
export function identityUrl(path) { return `${process.env.IDENTITY_URL || 'http://localhost:3001'}${path}`; }
export function scheduleUrl(path) { return `${process.env.SCHEDULE_URL || 'http://localhost:3003'}${path}`; }
export function staffUrl(path) { return `${process.env.STAFF_URL || 'http://localhost:3002'}${path}`; }
export async function call(url, options = {}) {
  const response = await fetch(url, { ...options, headers: {'content-type':'application/json','X-Service-Token':process.env.INTERNAL_API_KEY, ...options.headers}, signal: AbortSignal.timeout(5000)});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(response.status, body.error?.message || body.error || 'Dịch vụ liên quan không khả dụng');
  return body;
}
export async function auth(req,res,next){const middleware=await import('../packages/http.mjs').then(m=>m.authMiddleware());return middleware(req,res,error=>{if(error)return next(error);req.actor={...req.account,id:req.account.employeeId||req.account.accountId};next();});}
export function manager(req, branchId) {
  if (req.actor?.role !== 'QUAN_LY_CHI_NHANH' || req.actor.branchId !== branchId) throw fail(403, 'Không có quyền quản lý chi nhánh này');
}
export function requiredText(value, name, max = 255) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(400, `${name} không hợp lệ`);
  return value.trim();
}
export function validDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) throw fail(400, `${name} không hợp lệ`);
  return value;
}
export function validDatetime(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) throw fail(400, `${name} phải là ISO UTC`);
  return new Date(value).toISOString().slice(0,19).replace('T',' ');
}
