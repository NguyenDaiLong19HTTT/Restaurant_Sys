import {readFileSync} from 'node:fs';import {timingSafeEqual} from 'node:crypto';
import express from 'express';
import {common,authMiddleware,roles,errors,notFound,ApiError} from '../../../packages/http.mjs';
import {paymentCore} from './core.mjs';
import {providerParams} from './vnpay.mjs';
import {json} from './db.mjs';
import {tableAdapter} from './tables.mjs';
import {calculate} from './pricing.mjs';
export async function createPaymentApp(pool,orders,vnp,tables=tableAdapter(pool)){
 const core=paymentCore(pool,orders,vnp,tables),app=express();common(app);app.use(express.json({limit:'32kb'}));
 app.get('/internal/v1/payments/:id/status',async(req,res)=>{const a=Buffer.from(req.get('X-Service-Token')||''),b=Buffer.from(readFileSync(process.env.ORDER_SERVICE_TOKEN_FILE,'utf8').trim());if(a.length!==b.length||!timingSafeEqual(a,b))throw new ApiError(401,'SERVICE_UNAUTHENTICATED','Service credentials required');const [[p]]=await pool.execute('SELECT id,order_id,branch_id,state,total_vnd FROM payments WHERE id=?',[req.params.id]);if(!p)throw new ApiError(404,'PAYMENT_NOT_FOUND','Payment not found');const [[checkout]]=await pool.execute('SELECT needs_review FROM payment_orders WHERE order_id=?',[p.order_id]);res.json({data:{id:p.id,orderId:p.order_id,branchId:p.branch_id,state:p.state,totalVnd:Number(p.total_vnd),needsReview:Boolean(checkout?.needs_review)}});});
 app.get('/health/live',(req,res)=>res.json({data:{status:'UP'}}));
 app.get('/health/ready',async(req,res)=>{await pool.query('SELECT 1');res.json({data:{status:'READY'}});});
 // The only provider callback exception to JWT; checksum and transaction matching are mandatory.
 app.get('/api/v1/payments/vnpay/ipn',async(req,res)=>{try{res.json(await core.ipn(providerParams(req.originalUrl)));}catch{res.json({RspCode:'99',Message:'Unable to process'});}});
 app.get('/api/v1/payments/vnpay/return',(req,res)=>res.json({data:{message:'Return URL chỉ hiển thị. Đăng nhập để đọc trạng thái đã xác minh từ backend.'}}));
 app.use('/api/v1/payments',await authMiddleware(),roles('NHAN_VIEN_TIEP_NHAN'));
 app.get('/api/v1/payments/config',(req,res)=>res.json({data:{vnpayEnabled:vnp.enabled,demoOrders:orders.demo,demoTables:tables.demo}}));
 app.get('/api/v1/payments/tables',async(req,res)=>{const rows=await tables.list(req.account.branchId);if(!Array.isArray(rows)||rows.some(t=>t.branchId!==req.account.branchId))throw new ApiError(503,'INVALID_TABLE_SCOPE','Table-service trả dữ liệu sai chi nhánh');res.json({data:rows});});
 app.get('/api/v1/payments/tables/:id/orders',async(req,res)=>{const table=await core.selectedTable(req.params.id,req.account),rows=await orders.list(req.account.branchId,table.id);if(!Array.isArray(rows)||rows.some(o=>o.branchId!==req.account.branchId||o.tableId!==table.id||o.paymentStatus!=='UNPAID'))throw new ApiError(503,'INVALID_ORDER_SCOPE','Order-service trả danh sách sai bàn/chi nhánh');res.json({data:rows.map(o=>({...o,...calculate(o.items)}))});});
 app.get('/api/v1/payments/orders',async(req,res)=>{const table=await core.selectedTable(req.query.tableId,req.account);res.json({data:await orders.list(req.account.branchId,table.id)});});
 app.get('/api/v1/payments/orders/:id',async(req,res)=>{
  const order=await orders.get(req.params.id);core.scope(order.branchId,req.account);
  if(req.query.tableId!==order.tableId)throw new ApiError(409,'ORDER_TABLE_MISMATCH','Order không thuộc bàn đã chọn');
  await core.selectedTable(req.query.tableId,req.account);
  const[[o]]=await pool.execute('SELECT active_payment_id,needs_review FROM payment_orders WHERE order_id=?',[order.id]);
  res.json({data:{order:{...order,...calculate(order.items)},payment:o?.active_payment_id?await core.detail(o.active_payment_id,req.account):null}});
 });
 app.post('/api/v1/payments/quote',async(req,res)=>res.json({data:await core.quote(req.body?.orderId,req.body?.voucherCode,req.account,req.body?.tableId)}));
 app.get('/api/v1/payments/by-reference/:ref',async(req,res)=>{const[[p]]=await pool.execute('SELECT id FROM payments WHERE txn_ref=?',[req.params.ref]);if(!p)throw new ApiError(404,'PAYMENT_NOT_FOUND','Không tìm thấy thanh toán');res.json({data:await core.detail(p.id,req.account)});});
 app.post('/api/v1/payments',async(req,res)=>res.status(201).json({data:await core.create(req.body,req.get('Idempotency-Key'),req.account,req.get('X-Client-Ip')||req.socket.remoteAddress?.replace(/^::ffff:/,''))}));
 app.get('/api/v1/payments/:id',async(req,res)=>res.json({data:await core.detail(req.params.id,req.account)}));
 app.post('/api/v1/payments/:id/query',async(req,res)=>res.json({data:await core.query(req.params.id,req.account)}));
 app.post('/api/v1/payments/:id/confirm',async(req,res)=>res.json({data:await core.confirm(req.params.id,req.body,req.account)}));
 app.post('/api/v1/payments/:id/cancel',async(req,res)=>res.json({data:await core.cancel(req.params.id,req.account)}));
 app.get('/api/v1/payments/:id/invoice',async(req,res)=>res.json({data:await core.invoice(req.params.id,req.account)}));
 app.use(notFound);
 app.use((err,req,res,next)=>{if(['ER_DUP_ENTRY','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(err.code))return next(new ApiError(409,'PAYMENT_CONFLICT','Giao dịch đang được xử lý. Tải lại trạng thái trước khi thử tiếp.'));next(err);});
 app.use(errors);return {app,core};
}
