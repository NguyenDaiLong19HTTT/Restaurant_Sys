import {randomUUID,createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {ApiError} from '../../../packages/http.mjs';
import {calculate,voucherCode} from './pricing.mjs';
import {transaction,json} from './db.mjs';
import {vnTime,verifyParameters} from './vnpay.mjs';
import {snapshotHash} from './snapshot.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export const paymentView=p=>({id:p.id,orderId:p.order_id,branchId:p.branch_id,method:p.method,state:p.state,subtotalVnd:Number(p.subtotal_vnd),discountVnd:Number(p.discount_vnd),totalVnd:Number(p.total_vnd),voucherCode:p.voucher_code,reference:p.txn_ref,providerResult:p.provider_result,createdAt:new Date(p.created_at).toISOString(),completedAt:p.completed_at?new Date(p.completed_at).toISOString():null});
export function paymentCore(pool,orders,vnp,tables){
 const workerGroup=process.env.PAYMENT_WORKER_GROUP||'default';
 const scope=(branch,account)=>{if(branch!==account.branchId)throw new ApiError(403,'BRANCH_FORBIDDEN','Order không thuộc chi nhánh của bạn');};
 async function selectedTable(id,account){if(typeof id!=='string'||!id||id.length>64)throw new ApiError(422,'TABLE_REQUIRED','Hãy chọn một bàn');const t=await tables.get(id);scope(t.branchId,account);if(t.status!=='ACTIVE')throw new ApiError(409,'TABLE_INACTIVE','Bàn không còn hoạt động');return t;}
 async function freshSnapshot(c,p,o,allowOwnPaid=false){
  const saved=json(o.snapshot);
  if(!saved.tableId)return 'TABLE_ASSOCIATION_MISSING';
  const table=await tables.get(saved.tableId,c,tables.demo),current=await orders.get(p.order_id,c,orders.demo);
  if(current.id!==p.order_id||current.branchId!==p.branch_id||current.tableId!==saved.tableId||table.branchId!==p.branch_id||table.status!=='ACTIVE')return 'TABLE_OR_BRANCH_CHANGED';
  if(snapshotHash(current)!==snapshotHash(saved))return 'ORDER_SNAPSHOT_CHANGED';
  if(current.paymentStatus!=='UNPAID'&&!(allowOwnPaid&&current.paidPaymentId===p.id))return 'ORDER_ALREADY_PAID';
  return null;
 }
 async function invalidate(c,p,o,reason){
  await c.execute('UPDATE payments SET stale_reason=? WHERE id=?',[reason,p.id]);
  if(p.method==='CASH'&&p.state==='CASH_PENDING'){await releaseVoucher(c,p);await c.execute("UPDATE payments SET state='CANCELLED' WHERE id=?",[p.id]);}
  if(['RECEIVED','FINALIZING'].includes(p.state)||reason==='ORDER_ALREADY_PAID')await c.execute('UPDATE payment_orders SET needs_review=TRUE WHERE order_id=?',[o.order_id]);
  return {stale:true,paymentId:p.id};
 }
 const staleError=result=>new ApiError(409,'ORDER_SNAPSHOT_CHANGED','Order/bàn đã thay đổi. Tải lại chi tiết và kiểm tra lại số tiền. Yêu cầu VNPay cũ không được sử dụng lại.',{paymentId:result.paymentId,refreshOrder:true});
 async function orderContext(id,account,lock=false){if(typeof id!=='string'||id.length>64||!id)throw new ApiError(422,'INVALID_ORDER_ID','Cần orderId cụ thể');const o=await (lock?orders.lock(id):orders.get(id));if(!o||o.id!==id||!Number.isSafeInteger(o.version)||o.version<1||!['UNPAID','PAID'].includes(o.paymentStatus))throw new ApiError(503,'INVALID_ORDER_CONTEXT','Order-service trả thông tin không khớp; không thể thu tiền');scope(o.branchId,account);if(!['SUBMITTED','HANDED_OVER'].includes(o.status))throw new ApiError(409,'ORDER_NOT_PAYABLE','Order chưa đủ điều kiện thanh toán');return o;}
 async function voucher(c,code,lock=false){if(!code)return null;const[[v]]=await c.execute(`SELECT * FROM vouchers WHERE code=?${lock?' FOR UPDATE':''}`,[code]);if(!v)throw new ApiError(422,'VOUCHER_UNAVAILABLE','Không tìm thấy voucher',{voucherCode:'Không tìm thấy voucher'});return v;}
 async function locked(c,id){
  const[[first]]=await c.execute('SELECT order_id FROM payments WHERE id=?',[id]);if(!first)throw new ApiError(404,'PAYMENT_NOT_FOUND','Không tìm thấy thanh toán');
  const[[o]]=await c.execute('SELECT * FROM payment_orders WHERE order_id=? FOR UPDATE',[first.order_id]);
  const[[p]]=await c.execute('SELECT * FROM payments WHERE id=? FOR UPDATE',[id]);return {p,o};
 }
 async function releaseVoucher(c,p){if(!p.voucher_code)return;await c.execute('SELECT code FROM vouchers WHERE code=? FOR UPDATE',[p.voucher_code]);const[[r]]=await c.execute('SELECT * FROM voucher_reservations WHERE payment_id=? FOR UPDATE',[p.id]);if(r?.state==='HELD'){await c.execute('UPDATE vouchers SET held_count=held_count-1 WHERE code=?',[p.voucher_code]);await c.execute("UPDATE voucher_reservations SET state='RELEASED' WHERE payment_id=?",[p.id]);}}
 async function detail(id,account){
  const[[p]]=await pool.execute('SELECT * FROM payments WHERE id=?',[id]);if(!p)throw new ApiError(404,'PAYMENT_NOT_FOUND','Không tìm thấy thanh toán');scope(p.branch_id,account);
  const[[o]]=await pool.execute('SELECT * FROM payment_orders WHERE order_id=?',[p.order_id]);const[[invoice]]=await pool.execute('SELECT id,code FROM invoices WHERE payment_id=?',[id]);const snapshot=json(o.snapshot);
  let changed=p.stale_reason||null,validationUnavailable=false;
  if(['CASH_PENDING','PROVIDER_PENDING','RECEIVED'].includes(p.state)){try{changed ||= await freshSnapshot(pool,p,o);}catch{validationUnavailable=true;}}
  return {...paymentView(p),tableId:snapshot.tableId||null,snapshotHash:snapshotHash(snapshot),snapshotChanged:Boolean(changed),staleReason:changed,validationUnavailable,order:{...snapshot,items:calculate(snapshot.items).items,paymentStatus:p.state==='COMPLETED'?'PAID':snapshot.paymentStatus},needsReview:Boolean(o.needs_review),invoice:invoice||null,demo:orders.demo,paymentUrl:p.method==='VNPAY'&&p.state==='PROVIDER_PENDING'&&vnp.enabled&&!o.needs_review&&!changed&&!validationUnavailable?vnp.paymentUrl(p):null};
 }
 async function quote(orderId,code,account,tableId){const table=await selectedTable(tableId,account),o=await orderContext(orderId,account);if(o.tableId!==table.id)throw new ApiError(409,'ORDER_TABLE_MISMATCH','Order không thuộc bàn đã chọn');if(o.paymentStatus!=='UNPAID')throw new ApiError(409,'ORDER_ALREADY_PAID','Order đã thanh toán');return {table,order:o,snapshotHash:snapshotHash(o),...calculate(o.items,await voucher(pool,voucherCode(code))),voucherCode:voucherCode(code),demo:orders.demo};}
 async function create(body,key,account,clientIp='127.0.0.1'){
  if(!isIP(clientIp))throw new ApiError(400,'INVALID_CLIENT_IP','Địa chỉ IP không hợp lệ');
  if(!key||!/^[-a-zA-Z0-9_]{8,128}$/.test(key))throw new ApiError(400,'IDEMPOTENCY_KEY_REQUIRED','Cần Idempotency-Key từ 8–128 ký tự');
  if(!body||!['CASH','VNPAY'].includes(body.method)||Object.keys(body).some(k=>!['orderId','tableId','expectedSnapshotHash','method','voucherCode'].includes(k)))throw new ApiError(422,'INVALID_PAYMENT','Chỉ nhận orderId, tableId, expectedSnapshotHash, method và voucherCode');
  if(!/^[a-f0-9]{64}$/.test(body.expectedSnapshotHash||''))throw new ApiError(422,'SNAPSHOT_REQUIRED','Cần đọc và kiểm tra chi tiết order trước khi thanh toán');
  if(body.method==='VNPAY'&&!vnp.enabled)throw new ApiError(503,'VNPAY_NOT_CONFIGURED','Chưa có thông tin cấu hình VNPay Sandbox');
  // Check scope before requesting a payment lock from a real order-service.
  await orderContext(body.orderId,account);
  const table=await selectedTable(body.tableId,account);
  const context=await orderContext(body.orderId,account),code=voucherCode(body.voucherCode);
  if(context.tableId!==table.id)throw new ApiError(409,'ORDER_TABLE_MISMATCH','Order không thuộc bàn đã chọn');
  if(snapshotHash(context)!==body.expectedSnapshotHash)throw staleError({});
  context.tableName=table.name;
  const keyScope=hash(`${account.accountId}:${key}`),requestHash=hash(JSON.stringify({orderId:body.orderId,tableId:body.tableId,snapshotHash:body.expectedSnapshotHash,method:body.method,voucherCode:code}));
  const id=await transaction(pool,async c=>{
   await c.execute('INSERT INTO payment_keys(scope_key,request_hash) VALUES (?,?) ON DUPLICATE KEY UPDATE scope_key=scope_key',[keyScope,requestHash]);
   const[[saved]]=await c.execute('SELECT * FROM payment_keys WHERE scope_key=? FOR UPDATE',[keyScope]);
   if(saved.request_hash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Key đã được dùng cho yêu cầu khác');
   if(saved.payment_id){const{p,o}=await locked(c,saved.payment_id);if(['CASH_PENDING','PROVIDER_PENDING','RECEIVED'].includes(p.state)){const reason=p.stale_reason||await freshSnapshot(c,p,o);if(reason)return invalidate(c,p,o,reason);}return saved.payment_id;}
   const computed=calculate(context.items);
   await c.execute('INSERT INTO payment_orders(order_id,branch_id,snapshot,subtotal_vnd,order_version) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE order_id=order_id',[context.id,context.branchId,JSON.stringify(context),computed.subtotalVnd,context.version]);
   const[[o]]=await c.execute('SELECT * FROM payment_orders WHERE order_id=? FOR UPDATE',[context.id]);scope(o.branch_id,account);
   if(o.needs_review)throw new ApiError(409,'PAYMENT_REVIEW_REQUIRED','Giao dịch cần đối soát thủ công; không thu tiền thêm');
   if(o.active_payment_id){
    const[[current]]=await c.execute('SELECT * FROM payments WHERE id=? FOR UPDATE',[o.active_payment_id]);
    if(!['FAILED','CANCELLED'].includes(current.state)){
     if(['CASH_PENDING','PROVIDER_PENDING','RECEIVED'].includes(current.state)){const reason=current.stale_reason||await freshSnapshot(c,current,o);if(reason)return invalidate(c,current,o,reason);}
     if(current.method!==body.method||current.voucher_code!==code)throw new ApiError(409,'PAYMENT_ALREADY_PENDING','Đang có yêu cầu thanh toán. Không được tạo yêu cầu thu tiền mới.',{paymentId:current.id});
     await c.execute('UPDATE payment_keys SET payment_id=? WHERE scope_key=?',[current.id,keyScope]);return current.id;
    }
   }
   if(o.paid_payment_id||context.paymentStatus==='PAID')throw new ApiError(409,'ORDER_ALREADY_PAID','Order đã thanh toán');
   const checkedTable=await tables.get(table.id,c,tables.demo),rechecked=await orders.get(context.id,c,orders.demo);
   if(snapshotHash(rechecked)!==body.expectedSnapshotHash||rechecked.paymentStatus!=='UNPAID'||checkedTable.branchId!==account.branchId||checkedTable.status!=='ACTIVE')throw staleError({});
   const newId=keyScope.slice(0,8)+'-'+keyScope.slice(8,12)+'-4'+keyScope.slice(13,16)+'-8'+keyScope.slice(17,20)+'-'+keyScope.slice(20,32);
   if(!orders.demo){const frozen=await orders.lock(context.id,{tableId:table.id,paymentId:newId,expectedSnapshotHash:body.expectedSnapshotHash,replacesPaymentId:o.active_payment_id||null});if(frozen.id!==context.id||frozen.branchId!==context.branchId||frozen.paymentStatus!=='UNPAID'||snapshotHash(frozen)!==body.expectedSnapshotHash)throw staleError({});context.paymentLockId=frozen.paymentLockId;}
   const totals=calculate(context.items,await voucher(c,code,true));
   if(body.method==='VNPAY'&&totals.totalVnd<5000)throw new ApiError(422,'VNPAY_MIN_AMOUNT','VNPay cần số tiền tối thiểu 5.000 VND');
   const id=newId,ref=randomUUID().replaceAll('-',''),created=vnTime(),expires=vnTime(new Date(Date.now()+15*60000));
   await c.execute('INSERT INTO payments(id,order_id,branch_id,method,state,subtotal_vnd,discount_vnd,total_vnd,voucher_code,txn_ref,provider_created_at,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,context.id,context.branchId,body.method,body.method==='CASH'?'CASH_PENDING':'PROVIDER_PENDING',totals.subtotalVnd,totals.discountVnd,totals.totalVnd,code,ref,created,expires,account.accountId]);
   await c.execute('UPDATE payments SET client_ip=? WHERE id=?',[clientIp,id]);
   if(code){await c.execute('UPDATE vouchers SET held_count=held_count+1 WHERE code=?',[code]);await c.execute('INSERT INTO voucher_reservations VALUES (?,?,?)',[id,code,'HELD']);}
   await c.execute('UPDATE payment_orders SET snapshot=?,subtotal_vnd=?,order_version=?,active_payment_id=? WHERE order_id=?',[JSON.stringify(context),totals.subtotalVnd,context.version,id,context.id]);
   await c.execute('UPDATE payment_keys SET payment_id=? WHERE scope_key=?',[id,keyScope]);return id;
  });
  if(id?.stale)throw staleError(id);
  return detail(id,account);
 }
 async function providerResult(params,source){
  if(params.vnp_TmnCode!==vnp.config.tmnCode)return {RspCode:'97',Message:'Invalid merchant'};
  const[[first]]=await pool.execute('SELECT id FROM payments WHERE txn_ref=?',[params.vnp_TxnRef||'']);
  if(!first)return {RspCode:'01',Message:'Order not found'};
  return transaction(pool,async c=>{
   const{p,o}=await locked(c,first.id);
   if(p.method!=='VNPAY')return {RspCode:'01',Message:'Payment not found'};
   if(!/^\d{1,12}$/.test(params.vnp_Amount||'')||BigInt(params.vnp_Amount)!==BigInt(p.total_vnd)*100n)return {RspCode:'04',Message:'Invalid amount'};
   if(!/^\d{2}$/.test(params.vnp_ResponseCode||'')||!/^\d{2}$/.test(params.vnp_TransactionStatus||''))return {RspCode:'99',Message:'Invalid status'};
   if(source==='QUERY'&&params.vnp_TransactionType!=='01')return {RspCode:'99',Message:'Not a payment transaction'};
   const success=params.vnp_ResponseCode==='00'&&(params.vnp_TransactionStatus==='00'||source==='QUERY'&&params.vnp_TransactionStatus==='20');
   const failed=params.vnp_TransactionStatus==='02'&&(source==='QUERY'||!['00','07','99'].includes(params.vnp_ResponseCode));
   if(success&&(!/^[1-9]\d{0,14}$/.test(params.vnp_TransactionNo||'')||!/^\d{14}$/.test(params.vnp_PayDate||'')))return {RspCode:'99',Message:'Missing transaction proof'};
   const eventHash=hash(JSON.stringify(Object.fromEntries(Object.entries(params).filter(([k])=>k!=='vnp_SecureHash').sort(([a],[b])=>a.localeCompare(b)))));
   await c.execute('INSERT IGNORE INTO provider_events(event_hash,payment_id,source,response_code,transaction_status) VALUES (?,?,?,?,?)',[eventHash,p.id,source,params.vnp_ResponseCode,params.vnp_TransactionStatus]);
   if(['FAILED','CANCELLED'].includes(p.state)&&success){await c.execute('UPDATE payment_orders SET needs_review=TRUE WHERE order_id=?',[o.order_id]);return {RspCode:'99',Message:'Conflicting result requires reconciliation'};}
   if(['RECEIVED','FINALIZING','COMPLETED'].includes(p.state)){
    if(failed||['04','07'].includes(params.vnp_TransactionStatus)){await c.execute('UPDATE payment_orders SET needs_review=TRUE WHERE order_id=?',[o.order_id]);return {RspCode:'99',Message:'Conflicting result requires reconciliation'};}
    if(success&&p.provider_transaction_no!==params.vnp_TransactionNo){await c.execute('UPDATE payment_orders SET needs_review=TRUE WHERE order_id=?',[o.order_id]);return {RspCode:'99',Message:'Conflicting transaction'};}
    return {RspCode:'02',Message:'Already confirmed'};
   }
   if(p.state==='FAILED')return {RspCode:'02',Message:'Already confirmed'};
   if(success){
    const[[duplicate]]=await c.execute('SELECT id FROM payments WHERE provider_transaction_no=? AND id<>?',[params.vnp_TransactionNo,p.id]);
    if(duplicate){await c.execute('UPDATE payment_orders SET needs_review=TRUE WHERE order_id=?',[o.order_id]);return {RspCode:'99',Message:'Duplicate provider transaction'};}
    await c.execute("UPDATE payments SET state='RECEIVED',provider_transaction_no=?,provider_result='00' WHERE id=?",[params.vnp_TransactionNo,p.id]);
   }else if(failed){await c.execute("UPDATE payments SET state='FAILED',provider_result=? WHERE id=?",[`${params.vnp_ResponseCode}/${params.vnp_TransactionStatus}`,p.id]);await releaseVoucher(c,p);}
   else await c.execute('UPDATE payments SET provider_result=? WHERE id=?',[`${params.vnp_ResponseCode}/${params.vnp_TransactionStatus}`,p.id]);
   return {RspCode:'00',Message:'Confirm success'};
  });
 }
 async function ipn(params){if(!vnp.enabled||!verifyParameters(params,vnp.config.hashSecret))return {RspCode:'97',Message:'Invalid signature'};return providerResult(params,'IPN');}
 async function query(id,account){
  const current=await detail(id,account);if(current.method!=='VNPAY')throw new ApiError(409,'NOT_VNPAY','Không phải giao dịch VNPay');
  if(!['PROVIDER_PENDING'].includes(current.state))return {...current,queryOutcome:'NO_QUERY_NEEDED'};
  const[[p]]=await pool.execute('SELECT * FROM payments WHERE id=?',[id]);const reqId=randomUUID().replaceAll('-','');
  await pool.execute('INSERT INTO query_requests(id,payment_id) VALUES (?,?)',[reqId,id]);
  let outcome='UNKNOWN';
  try{
   const data=await vnp.query(p,reqId);
   if(data.vnp_ResponseCode!=='00')outcome=`QUERY_API_${/^\d{2}$/.test(data.vnp_ResponseCode)?data.vnp_ResponseCode:'ERROR'}`;
   else if(data.vnp_TxnRef!==p.txn_ref)outcome='REFERENCE_MISMATCH';
   else {const ack=await providerResult(data,'QUERY');outcome=ack.RspCode==='00'?'VERIFIED':ack.RspCode==='02'?'ALREADY_VERIFIED':`REJECTED_${ack.RspCode}`;}
  }catch{outcome='UNVERIFIED_OR_UNAVAILABLE';}
  await pool.execute('UPDATE query_requests SET outcome=? WHERE id=?',[outcome,reqId]);
  return {...await detail(id,account),queryOutcome:outcome};
 }
 async function finish(c,p,o){
  if(o.paid_payment_id&&o.paid_payment_id!==p.id)throw new Error('ORDER_PAYMENT_CONFLICT');
  if(p.voucher_code){
   await c.execute('SELECT code FROM vouchers WHERE code=? FOR UPDATE',[p.voucher_code]);
   const[[r]]=await c.execute('SELECT * FROM voucher_reservations WHERE payment_id=? FOR UPDATE',[p.id]);
   if(r?.state!=='HELD')throw new Error('VOUCHER_RESERVATION_MISSING');
   await c.execute('UPDATE vouchers SET held_count=held_count-1,used_count=used_count+1 WHERE code=?',[p.voucher_code]);
   await c.execute("UPDATE voucher_reservations SET state='USED' WHERE payment_id=?",[p.id]);
   await c.execute('INSERT INTO voucher_uses(payment_id,order_id,code) VALUES (?,?,?)',[p.id,p.order_id,p.voucher_code]);
  }
  const snapshot=json(o.snapshot),id=randomUUID(),code=`INV-${id}`;
  const document={code,paymentId:p.id,orderId:p.order_id,orderCode:snapshot.code,tableId:snapshot.tableId,tableName:snapshot.tableName,branchId:p.branch_id,method:p.method,items:calculate(snapshot.items).items,subtotalVnd:Number(p.subtotal_vnd),discountVnd:Number(p.discount_vnd),totalVnd:Number(p.total_vnd),voucherCode:p.voucher_code,createdAt:new Date().toISOString(),demo:orders.demo};
  await c.execute('INSERT INTO invoices(id,code,payment_id,order_id,branch_id,document,total_vnd) VALUES (?,?,?,?,?,?,?)',[id,code,p.id,p.order_id,p.branch_id,JSON.stringify(document),p.total_vnd]);
  await c.execute('INSERT INTO revenue_entries(payment_id,order_id,invoice_id,branch_id,amount_vnd) VALUES (?,?,?,?,?)',[p.id,p.order_id,id,p.branch_id,p.total_vnd]);
  await c.execute("UPDATE payments SET state='COMPLETED',completed_at=CURRENT_TIMESTAMP(3) WHERE id=?",[p.id]);
  await c.execute('UPDATE payment_orders SET paid_payment_id=? WHERE order_id=?',[p.id,p.order_id]);
  await c.execute("UPDATE payment_outbox SET state='DONE',last_error=NULL WHERE payment_id=?",[p.id]);
 }
 async function drain(specificId=null){
  return transaction(pool,async c=>{
   const args=specificId?[workerGroup,specificId]:[workerGroup];
   const[[event]]=await c.execute(`SELECT * FROM payment_outbox WHERE worker_group=? AND state='PENDING' AND ${specificId?'payment_id=?':'next_at<=CURRENT_TIMESTAMP(3)'} ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED`,args);
   if(!event)return false;
   const{p,o}=await locked(c,event.payment_id);
   if(p.state==='COMPLETED'){await c.execute("UPDATE payment_outbox SET state='DONE' WHERE payment_id=?",[p.id]);return true;}
   if(p.state!=='FINALIZING')return false;
   if(o.needs_review){await c.execute("UPDATE payment_outbox SET next_at=DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY),last_error='REVIEW_REQUIRED' WHERE payment_id=?",[p.id]);return true;}
   if(!orders.demo){
    try{await orders.markPaid(p,json(o.snapshot));await tables.reconcile(p,json(o.snapshot),c);}catch{await c.execute("UPDATE payment_outbox SET attempts=attempts+1,next_at=DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 10 SECOND),last_error='OWNER_ACK_PENDING' WHERE payment_id=?",[p.id]);return false;}
   }else{
    const reason=await freshSnapshot(c,p,o,true);if(reason){await invalidate(c,p,o,reason);return true;}
    await c.execute("UPDATE demo_orders SET payment_status='PAID',paid_payment_id=? WHERE id=?",[p.id,p.order_id]);
    await tables.reconcile(p,json(o.snapshot),c);
   }
   await finish(c,p,o);return true;
  });
 }
 async function confirm(id,body,account){
  const result=await transaction(pool,async c=>{
   const{p,o}=await locked(c,id);scope(p.branch_id,account);
   if(o.needs_review)throw new ApiError(409,'PAYMENT_REVIEW_REQUIRED','Cần đối soát thủ công, không thu tiền thêm');
   if(['COMPLETED','FINALIZING'].includes(p.state))return;
   if(p.method==='CASH'&&body?.cashReceived!==true)throw new ApiError(422,'CASH_CONFIRMATION_REQUIRED','Phải xác nhận đã nhận đủ tiền mặt');
   if(!['CASH_PENDING','RECEIVED'].includes(p.state))throw new ApiError(409,'PAYMENT_NOT_RECEIVED','Chưa có bằng chứng đã nhận tiền');
   const reason=p.stale_reason||await freshSnapshot(c,p,o);if(reason)return invalidate(c,p,o,reason);
   if(o.active_payment_id!==id||o.paid_payment_id)throw new ApiError(409,'ORDER_PAYMENT_CONFLICT','Order có giao dịch khác');
   await c.execute("UPDATE payments SET state='FINALIZING',confirmed_by=? WHERE id=?",[account.accountId,id]);
   await c.execute('INSERT IGNORE INTO payment_outbox(payment_id,worker_group) VALUES (?,?)',[id,workerGroup]);
  });
  if(result?.stale)throw staleError(result);
  await drain(id);return detail(id,account);
 }
 async function cancel(id,account){await transaction(pool,async c=>{const{p}=await locked(c,id);scope(p.branch_id,account);if(p.state==='CANCELLED')return;if(p.state!=='CASH_PENDING')throw new ApiError(409,'PAYMENT_CANNOT_CANCEL','Không hủy giao dịch chuyển khoản chưa rõ kết quả');await releaseVoucher(c,p);await c.execute("UPDATE payments SET state='CANCELLED' WHERE id=?",[id]);});if(orders.unlock){const [[p]]=await pool.execute('SELECT * FROM payments WHERE id=?',[id]);const [[o]]=await pool.execute('SELECT snapshot FROM payment_orders WHERE order_id=?',[p.order_id]);try{await orders.unlock(p,json(o.snapshot));}catch{/* Order owner retries terminal-lock cleanup durably. */}}return detail(id,account);}
 async function invoice(id,account){const[[row]]=await pool.execute('SELECT * FROM invoices WHERE payment_id=?',[id]);if(!row)throw new ApiError(404,'INVOICE_NOT_READY','Chưa có hóa đơn hoàn tất');scope(row.branch_id,account);return json(row.document);}
 return {detail,quote,create,ipn,query,confirm,cancel,invoice,drain,scope,selectedTable};
}
