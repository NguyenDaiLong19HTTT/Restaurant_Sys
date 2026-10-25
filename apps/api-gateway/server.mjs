import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { readFileSync } from 'node:fs';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import { SignJWT, importPKCS8 } from 'jose';
import { ApiError, common, errors, notFound, authMiddleware, secret } from '../../packages/http.mjs';
const app = express();
common(app);
app.use(express.json({ limit: '32kb' }));
const authenticate = await authMiddleware();
app.get('/health/live', (req, res) => res.json({ data: { status: 'UP' } }));
app.get('/health/ready', async (req, res) => {
  try { const r = await fetch(`${process.env.MENU_BASE_URL}/health/ready`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) throw new Error(); res.json({ data: { status: 'READY' } }); }
  catch { throw new ApiError(503, 'MENU_UNAVAILABLE', 'Dịch vụ món ăn chưa sẵn sàng'); }
});
app.get('/api/v1/auth/config', (req, res) => res.json({ data: { development: process.env.AUTH_MODE === 'development' } }));
if (process.env.AUTH_MODE === 'development') {
  const privateKey = await importPKCS8(secret('JWT_PRIVATE_KEY_FILE'), 'RS256');
  const users = JSON.parse(readFileSync(process.env.DEMO_USERS_FILE, 'utf8'));
  app.post('/api/v1/auth/login', rateLimit({ windowMs: 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Thử lại sau một phút', details: {} }, requestId: req.requestId }) }), async (req, res) => {
    const user = users.find(u => u.username === req.body?.username);
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length > 256) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không đúng');
    const hash = scryptSync(password, user?.salt || 'invalid-user-salt', 64);
    if (!user || !timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không đúng');
    const account = { id: user.id, role: user.role, branchId: user.branchId, username: user.username };
    const accessToken = await new SignJWT({ accountId: user.id, role: user.role, branchId: user.branchId, tokenVersion: 1, tokenUse: 'access' }).setProtectedHeader({ alg: 'RS256' }).setSubject(user.id).setIssuer(process.env.JWT_ISSUER).setAudience(process.env.JWT_AUDIENCE).setIssuedAt().setExpirationTime('30m').sign(privateKey);
    res.json({ data: { accessToken, account, development: true } });
  });
} else {
  app.post('/api/v1/auth/login', async (req, res) => {
    const response = await fetch(`${process.env.IDENTITY_BASE_URL}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': req.requestId }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(5000) });
    res.status(response.status).type('json').send(await response.text());
  });
}
for(const endpoint of ['refresh','logout','change-password'])app.post('/api/v1/auth/'+endpoint,async(req,res,next)=>{try{const r=await fetch(process.env.IDENTITY_BASE_URL+'/api/v1/auth/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(req.get('Authorization')?{Authorization:req.get('Authorization')}:{})},body:JSON.stringify(req.body),signal:AbortSignal.timeout(5000)});res.status(r.status).type('json').send(r.status===204?undefined:await r.text());}catch{next(new ApiError(503,'IDENTITY_UNAVAILABLE','Identity tạm gián đoạn'));}});
app.get('/api/v1/auth/me', authenticate, (req, res) => res.json({ data: { id: req.account.accountId, role: req.account.role, branchId: req.account.branchId, development: process.env.AUTH_MODE === 'development' } }));
// Only IPN and the display-only return endpoint bypass JWT. Never forward /internal.
app.use('/api/v1/payments', async (req, res, next) => {
  const publicCallback = req.method === 'GET' && ['/vnpay/ipn', '/vnpay/return'].includes(req.path);
  const forward = async () => {
    if (!['GET', 'POST'].includes(req.method) || !/^\/(?:[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+){0,2})?$/.test(req.path)) return next();
    try {
      const headers = { 'Content-Type': 'application/json', 'X-Request-Id': req.requestId };
      const peer=req.socket.remoteAddress?.replace(/^::ffff:/,'');
      let clientIp=peer;
      try{const proxies=await lookup('web',{all:true});if(proxies.some(p=>p.address===peer)&&isIP(req.get('X-Real-IP')||''))clientIp=req.get('X-Real-IP');}catch{/* Direct API request: use peer address, never trust a client-supplied IP header. */}
      if(isIP(clientIp||''))headers['X-Client-Ip']=clientIp;
      for (const key of ['Authorization', 'Idempotency-Key']) if (req.get(key)) headers[key] = req.get(key);
      const upstream = await fetch(`${process.env.PAYMENT_BASE_URL}${req.originalUrl}`, { method: req.method, headers, body: req.method === 'POST' ? JSON.stringify(req.body) : undefined, signal: AbortSignal.timeout(12000), redirect: 'error' });
      res.status(upstream.status).type('json').send(await upstream.text());
    } catch { res.status(publicCallback ? 200 : 503).json(publicCallback ? { RspCode: '99', Message: 'Payment unavailable' } : { error: { code: 'PAYMENT_UNAVAILABLE', message: 'Dịch vụ thanh toán đang gián đoạn. Kiểm tra lại trạng thái trước khi thu tiền.', details: {} }, requestId: req.requestId }); }
  };
  if (publicCallback) return forward();
  return authenticate(req, res, err => err ? next(err) : forward());
});
// Public allowlist: /internal is never forwarded, even with a service token.
app.use('/api/v1/dishes', authenticate, async (req, res, next) => {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method) || !/^\/(?:[a-zA-Z0-9-]+)?$/.test(req.path)) return next();
  try {
    const headers = { Authorization: req.get('Authorization'), 'Content-Type': 'application/json', 'X-Request-Id': req.requestId };
    for (const key of ['If-Match', 'Idempotency-Key']) if (req.get(key)) headers[key] = req.get(key);
    const upstream = await fetch(`${process.env.MENU_BASE_URL}${req.originalUrl}`, { method: req.method, headers, body: ['POST', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : undefined, signal: AbortSignal.timeout(5000) });
    for (const key of ['etag', 'location']) if (upstream.headers.has(key)) res.set(key, upstream.headers.get(key));
    res.status(upstream.status).type('json').send(upstream.status === 204 ? undefined : await upstream.text());
  } catch { next(new ApiError(503, 'MENU_UNAVAILABLE', 'Dịch vụ món ăn tạm thời gián đoạn. Vui lòng thử lại.')); }
});
const namespaces=[['/api/v1/order-reservations','http://reservation-service:3000'],['/api/v1/orders','http://order-service:3000'],['/api/v1/reservations','http://reservation-service:3000'],['/api/v1/branches','http://reservation-service:3000'],['/api/v1/tables','http://reservation-service:3000'],...['ingredients','transfer-requests','export-slips','import-slips'].map(x=>['/api/v1/'+x,'http://inventory-service:3000']),['/api/v1/staff','http://staff-service:3000'],['/api/v1/schedule','http://schedule-service:3000']];
for(let [prefix,base] of namespaces)app.use(prefix,async(req,res,next)=>{const publicBooking=prefix==='/api/v1/reservations'&&req.method==='POST'&&req.path==='/',publicBranches=prefix==='/api/v1/branches'&&req.method==='GET'&&req.path==='/';const forward=async()=>{if(req.path.includes('internal')||!/^[/a-zA-Z0-9-]*$/.test(req.path)||!['GET','POST','PATCH','DELETE'].includes(req.method))return next();try{let route=req.originalUrl;if(prefix==='/api/v1/staff'||prefix==='/api/v1/schedule')route=route.slice(prefix.length);if(prefix==='/api/v1/branches'&&/\/(stock|stock\/movements)(?:\?|$)/.test(route))route=route;const upstreamBase=prefix==='/api/v1/branches'&&/\/(stock|stock\/movements)(?:\?|$)/.test(route)?'http://inventory-service:3000':base;const headers={'Content-Type':'application/json','X-Request-Id':req.requestId};for(const h of ['Authorization','If-Match','Idempotency-Key'])if(req.get(h))headers[h]=req.get(h);const r=await fetch(upstreamBase+route,{method:req.method,headers,body:['POST','PATCH','DELETE'].includes(req.method)?JSON.stringify(req.body):undefined,signal:AbortSignal.timeout(10000)});for(const h of ['etag','location'])if(r.headers.has(h))res.set(h,r.headers.get(h));let text=await r.text();if(r.status!==204){try{const value=JSON.parse(text);if(prefix.includes('/staff')||prefix.includes('/schedule'))text=JSON.stringify(r.ok?{data:value}:{error:typeof value.error==='string'?{message:value.error,details:{}}:value.error});}catch{}}res.status(r.status).type('json').send(r.status===204?undefined:text);}catch{next(new ApiError(503,'SERVICE_UNAVAILABLE','Dịch vụ tạm gián đoạn. Kiểm tra trạng thái trước khi thử lại.'));}};if(publicBooking||publicBranches)return forward();return authenticate(req,res,err=>err?next(err):forward());});
app.use(notFound);
app.use(errors);
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('api-gateway ready'));
process.on('SIGTERM', () => server.close());
