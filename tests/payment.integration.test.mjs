import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {SignJWT,importPKCS8} from 'jose';
import {database,migrate,json} from '../services/payment/src/db.mjs';
import {orderAdapter} from '../services/payment/src/orders.mjs';
import {provider,signParameters,signFields,queryResponseFields,queryRequestFields,vnTime} from '../services/payment/src/vnpay.mjs';
import {createPaymentApp} from '../services/payment/src/app.mjs';
import {snapshotHash} from '../services/payment/src/snapshot.mjs';
import {tableAdapter} from '../services/payment/src/tables.mjs';
const pool=database(),config={enabled:true,tmnCode:'TESTONLY',hashSecret:randomBytes(32).toString('hex'),returnUrl:'https://test.invalid/app/thanh-toan/ket-qua',paymentUrl:'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',queryUrl:'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction',serverIp:'127.0.0.1'};
let server,base,core,tokens={},queryMode='pending',transactionNo=String(Date.now());
const ids=[];
const vnp=provider(config,async(url,options)=>{
 const request=JSON.parse(options.body);assert.equal(request.vnp_SecureHash,signFields(request,queryRequestFields,config.hashSecret));
 const[[p]]=await pool.execute('SELECT * FROM payments WHERE txn_ref=?',[request.vnp_TxnRef]);
 assert.equal(request.vnp_TransactionDate,p.provider_created_at);
 if(queryMode==='timeout')throw new Error('test timeout');
 const data={vnp_ResponseId:randomUUID().replaceAll('-',''),vnp_Command:'querydr',vnp_ResponseCode:queryMode==='notfound'?'91':'00',vnp_Message:'Test only',vnp_TmnCode:config.tmnCode,vnp_TxnRef:queryMode==='wrongref'?'different-reference':p.txn_ref,vnp_Amount:String(BigInt(p.total_vnd)*100n+(queryMode==='wrongamount'?100n:0n)),vnp_BankCode:'NCB',vnp_PayDate:vnTime(),vnp_TransactionNo:transactionNo=String(BigInt(transactionNo)+1n),vnp_TransactionType:'01',vnp_TransactionStatus:queryMode==='success'?'00':queryMode==='failure'?'02':'01',vnp_OrderInfo:'Test query',vnp_PromotionCode:'',vnp_PromotionAmount:''};
 if(queryMode==='settled')data.vnp_TransactionStatus='20';
 data.vnp_SecureHash=signFields(data,queryResponseFields,config.hashSecret);if(queryMode==='badsignature')data.vnp_SecureHash='0'.repeat(128);
 return {ok:true,json:async()=>data};
});
async function request(path,{role='reception',method='GET',body,headers={}}={}){if(path==='/quote'&&body?.orderId&&!Object.hasOwn(body,'tableId'))body={...body,tableId:(await orderAdapter(pool).get(body.orderId)).tableId};const r=await fetch(`${base}/api/v1/payments${path}`,{method,headers:{'Content-Type':'application/json',...(tokens[role]?{Authorization:`Bearer ${tokens[role]}`} : {}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
async function order(branch='demo-branch-a',items=null){const id=`test-pay-${randomUUID()}`;ids.push(id);await pool.execute('INSERT INTO demo_orders(id,branch_id,code,items,table_id) VALUES (?,?,?,?,?)',[id,branch,id,JSON.stringify(items||[{dishNameSnapshot:'Phở snapshot',unitPriceVnd:85000,quantity:2},{dishNameSnapshot:'Trà snapshot',unitPriceVnd:39000,quantity:2}]),'demo-table-3']);return id;}
const create=async(orderId,method='CASH',voucherCode=null,key=randomUUID())=>{const context=await orderAdapter(pool).get(orderId);return request('',{method:'POST',headers:{'Idempotency-Key':key},body:{orderId,tableId:context.tableId,expectedSnapshotHash:snapshotHash(context),method,voucherCode}});};
function callback(p,overrides={}){const d={vnp_TmnCode:config.tmnCode,vnp_TxnRef:p.reference,vnp_Amount:String(BigInt(p.totalVnd)*100n),vnp_ResponseCode:'00',vnp_TransactionStatus:'00',vnp_TransactionNo:transactionNo=String(BigInt(transactionNo)+1n),vnp_PayDate:vnTime(),vnp_BankCode:'NCB',...overrides};d.vnp_SecureHash=signParameters(d,config.hashSecret);return d;}
const ipn=async d=>request(`/vnpay/ipn?${new URLSearchParams(d)}`,{role:'none'});
const confirm=id=>request(`/${id}/confirm`,{method:'POST',body:{cashReceived:true}});
async function counts(p){const result={};for(const table of ['invoices','revenue_entries','voucher_uses']){const[[r]]=await pool.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE payment_id=?`,[p.id]);result[table]=Number(r.n);}return result;}
before(async()=>{
 process.env.PAYMENT_WORKER_GROUP=`test-${randomUUID()}`;
 await migrate(pool);const app=await createPaymentApp(pool,orderAdapter(pool),vnp);core=app.core;server=app.app.listen(0,'0.0.0.0');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
 const key=await importPKCS8(readFileSync(process.env.JWT_PRIVATE_KEY_FILE,'utf8'),'RS256');
 for(const[role,branch]of [['reception','demo-branch-a'],['foreign','branch-b'],['owner',null],['server','demo-branch-a']]){const id=randomUUID();tokens[role]=await new SignJWT({accountId:id,role:role==='owner'?'CHU_CHUOI':role==='server'?'NHAN_VIEN_PHUC_VU':'NHAN_VIEN_TIEP_NHAN',branchId:branch,tokenVersion:1,tokenUse:'access'}).setProtectedHeader({alg:'RS256'}).setSubject(id).setIssuer(process.env.JWT_ISSUER).setAudience(process.env.JWT_AUDIENCE).setExpirationTime('30m').sign(key);}
});
after(async()=>{await new Promise(r=>server.close(r));await pool.execute("UPDATE demo_orders SET status='CANCELLED' WHERE id LIKE 'test-pay-%' AND table_id IS NOT NULL AND payment_status='UNPAID'");await pool.execute("UPDATE demo_tables SET status='INACTIVE' WHERE id LIKE 'test-table-%'");await pool.end();});
test('payment API enforces reception role/branch and cannot trust client totals',async()=>{
 const id=await order();assert.equal((await request('/orders',{role:'none'})).status,401);
 for(const role of ['owner','server'])assert.equal((await request('/orders',{role})).status,403);
 assert.equal((await request(`/orders/${id}`,{role:'foreign'})).status,403);
 assert.equal((await request('/quote',{method:'POST',body:{orderId:id},role:'foreign'})).status,403);
 assert.equal((await request('',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:{orderId:id,method:'CASH',totalVnd:1}})).status,422);
 const q=await request('/quote',{method:'POST',body:{orderId:id,voucherCode:'GIAM10'}});assert.equal(q.body.data.totalVnd,223200);
 assert.equal((await request('/quote',{method:'POST',body:{orderId:id,voucherCode:'MISSING'}})).status,422);
});
test('cash requires received acknowledgement; concurrent confirms create invoice/revenue/voucher once',async()=>{
 const id=await order(),key=randomUUID();const[[before]]=await pool.execute("SELECT used_count FROM vouchers WHERE code='GIAM10'");
 const p=(await create(id,'CASH','GIAM10',key)).body.data;assert.equal(p.state,'CASH_PENDING');assert.equal(p.totalVnd,223200);
 assert.equal((await create(id,'CASH','GIAM10',key)).body.data.id,p.id);assert.equal((await create(id,'CASH','GIAM20K',key)).status,409);
 assert.equal((await request(`/${p.id}/confirm`,{method:'POST',body:{}})).status,422);assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});
 const results=await Promise.all([confirm(p.id),confirm(p.id),confirm(p.id)]);assert.ok(results.every(r=>r.status===200));
 const final=(await request(`/${p.id}`)).body.data;assert.equal(final.state,'COMPLETED');assert.deepEqual(await counts(p),{invoices:1,revenue_entries:1,voucher_uses:1});
 const invoice=(await request(`/${p.id}/invoice`)).body.data;assert.equal(invoice.totalVnd,p.totalVnd);assert.equal(invoice.items[0].unitPriceVnd,85000);
 const[[o]]=await pool.execute('SELECT payment_status FROM demo_orders WHERE id=?',[id]);assert.equal(o.payment_status,'PAID');
 const[[after]]=await pool.execute("SELECT used_count FROM vouchers WHERE code='GIAM10'");assert.equal(after.used_count,before.used_count+1);
 assert.equal((await request(`/${p.id}/invoice`,{role:'foreign'})).status,403);
});
test('only one payment attempt can be active for an order; pending provider blocks cash/retry',async()=>{
 const id=await order();const responses=await Promise.all([create(id,'VNPAY','GIAM20K'),create(id,'VNPAY','GIAM20K')]);
 assert.ok(responses.every(r=>r.status===201));const p=responses[0].body.data;assert.equal(p.id,responses[1].body.data.id);
 assert.equal(new URL(p.paymentUrl).searchParams.get('vnp_Amount'),String(p.totalVnd*100));
 assert.equal((await create(id,'CASH')).status,409);assert.equal((await confirm(p.id)).status,409);assert.equal((await request(`/${p.id}/cancel`,{method:'POST'})).status,409);
});
test('IPN rejects bad signature, wrong amount/merchant/reference, duplicate keys and Return never mutates',async()=>{
 const id=await order(),p=(await create(id,'VNPAY')).body.data,d=callback(p);
 assert.equal((await ipn({...d,vnp_SecureHash:'0'.repeat(128)})).body.RspCode,'97');
 assert.equal((await ipn(callback(p,{vnp_Amount:'100'}))).body.RspCode,'04');
 assert.equal((await ipn(callback(p,{vnp_TmnCode:'OTHER'}))).body.RspCode,'97');
 assert.equal((await ipn(callback(p,{vnp_TxnRef:randomUUID()}))).body.RspCode,'01');
 assert.equal((await request(`/vnpay/ipn?${new URLSearchParams(d)}&vnp_Amount=1`,{role:'none'})).body.RspCode,'99');
 assert.equal((await request(`/vnpay/return?${new URLSearchParams(d)}`,{role:'none'})).status,200);
 assert.equal((await request(`/${p.id}`)).body.data.state,'PROVIDER_PENDING');assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});
});
test('verified duplicate/concurrent IPNs only receive money; employee finalizes once',async()=>{
 const id=await order(),p=(await create(id,'VNPAY','GIAM10')).body.data,d=callback(p);
 const acks=await Promise.all([ipn(d),ipn(d),ipn(d)]);assert.deepEqual(acks.map(r=>r.body.RspCode).sort(),['00','02','02']);
 assert.equal((await request(`/${p.id}`)).body.data.state,'RECEIVED');assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});
 await Promise.all([confirm(p.id),confirm(p.id)]);assert.equal((await request(`/${p.id}`)).body.data.state,'COMPLETED');
 assert.equal((await ipn(d)).body.RspCode,'02');assert.deepEqual(await counts(p),{invoices:1,revenue_entries:1,voucher_uses:1});
});
test('QueryDR API success + transaction pending, not found, timeout and unverifiable responses do not fail payment',async()=>{
 const id=await order(),p=(await create(id,'VNPAY')).body.data;
 for(const mode of ['pending','notfound','timeout','badsignature','wrongref','wrongamount']){queryMode=mode;const r=await request(`/${p.id}/query`,{method:'POST'});assert.equal(r.status,200);assert.equal(r.body.data.state,'PROVIDER_PENDING');assert.equal((await create(id,'CASH')).status,409);}
 queryMode='success';const received=await request(`/${p.id}/query`,{method:'POST'});assert.equal(received.body.data.state,'RECEIVED');assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});await confirm(p.id);assert.equal((await request(`/${p.id}/invoice`)).body.data.totalVnd,p.totalVnd);
});
test('only definitive signed failure releases voucher; retry can choose cash; late contradictory success requires review',async()=>{
 const id=await order(),p=(await create(id,'VNPAY','GIAM20K')).body.data;
 const failed=callback(p,{vnp_ResponseCode:'24',vnp_TransactionStatus:'02'});assert.equal((await ipn(failed)).body.RspCode,'00');
 assert.equal((await request(`/${p.id}`)).body.data.state,'FAILED');const[[r]]=await pool.execute('SELECT state FROM voucher_reservations WHERE payment_id=?',[p.id]);assert.equal(r.state,'RELEASED');
 const cash=await create(id,'CASH','GIAM20K');assert.equal(cash.status,201);
 assert.equal((await ipn(callback(p))).body.RspCode,'99');assert.equal((await confirm(cash.body.data.id)).status,409);assert.equal((await create(id,'VNPAY')).status,409);
});
test('signed QueryDR transaction status 02 permits retry, but status 04 stays unresolved',async()=>{
 const p=(await create(await order(),'VNPAY')).body.data;queryMode='failure';assert.equal((await request(`/${p.id}/query`,{method:'POST'})).body.data.state,'FAILED');assert.equal((await create(p.orderId,'CASH')).status,201);
 const another=(await create(await order(),'VNPAY')).body.data;await ipn(callback(another,{vnp_ResponseCode:'00',vnp_TransactionStatus:'04'}));assert.equal((await request(`/${another.id}`)).body.data.state,'PROVIDER_PENDING');
});
test('outbox handles missing order acknowledgement: no premature invoice, retry survives service recreation',async()=>{
 const id=await order(),p=(await create(id,'CASH')).body.data;
 let remoteCalls=0,online=false;
 const demo=orderAdapter(pool),remote={...demo,demo:false,markPaid:async()=>{remoteCalls++;if(!online)throw new Error('timeout');}};
 const remoteTables={...tableAdapter(pool),demo:false,reconcile:async()=>{}};
 const second=await createPaymentApp(pool,remote,vnp,remoteTables),s=second.app.listen(0);await new Promise(r=>s.once('listening',r));
 try{
  const response=await fetch(`http://127.0.0.1:${s.address().port}/api/v1/payments/${p.id}/confirm`,{method:'POST',headers:{Authorization:`Bearer ${tokens.reception}`,'Content-Type':'application/json'},body:JSON.stringify({cashReceived:true})});assert.equal((await response.json()).data.state,'FINALIZING');assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});
  online=true;const restarted=await createPaymentApp(pool,remote,vnp,remoteTables);await restarted.core.drain(p.id);await restarted.core.drain(p.id);assert.equal((await request(`/${p.id}`)).body.data.state,'COMPLETED');assert.deepEqual(await counts(p),{invoices:1,revenue_entries:1,voucher_uses:0});assert.equal(remoteCalls,2);
 }finally{await new Promise(r=>s.close(r));}
});
test('MySQL payment user cannot read menu_db and completed invoice snapshot remains unchanged',async()=>{
 await assert.rejects(pool.query('SELECT id FROM menu_db.dishes LIMIT 1'),e=>['ER_TABLEACCESS_DENIED_ERROR','ER_DBACCESS_DENIED_ERROR'].includes(e.code));
 const id=await order(),p=(await create(id)).body.data;await confirm(p.id);const before=(await request(`/${p.id}/invoice`)).body.data;
 await pool.execute('UPDATE demo_orders SET items=? WHERE id=?',[JSON.stringify([{dishNameSnapshot:'Changed outside payment',unitPriceVnd:1,quantity:1}]),id]);
 assert.deepEqual((await request(`/${p.id}/invoice`)).body.data,before);
});
test('last voucher slot is reserved once under concurrency and counted only on completion',async()=>{
 const code=`ONE${randomUUID().replaceAll('-','')}`.toUpperCase();
 await pool.execute('INSERT INTO vouchers(code,kind,value,max_discount_vnd,min_total_vnd,max_uses,expires_at) VALUES (?,?,?,?,?,?,?)',[code,'FIXED',10000,10000,100000,1,'2099-01-01']);
 const a=await order(),b=await order(),responses=await Promise.all([create(a,'CASH',code),create(b,'CASH',code)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,422]);const winner=responses.find(r=>r.status===201).body.data;
 const[[held]]=await pool.execute('SELECT * FROM vouchers WHERE code=?',[code]);assert.equal(held.used_count,0);assert.equal(held.held_count,1);
 await confirm(winner.id);await confirm(winner.id);const[[used]]=await pool.execute('SELECT * FROM vouchers WHERE code=?',[code]);assert.equal(used.used_count,1);assert.equal(used.held_count,0);
});
test('a contradictory provider reversal after money was received blocks completion',async()=>{
 const p=(await create(await order(),'VNPAY')).body.data;
 await ipn(callback(p));await ipn(callback(p,{vnp_ResponseCode:'00',vnp_TransactionStatus:'04'}));
 const result=(await request(`/${p.id}`)).body.data;assert.equal(result.state,'RECEIVED');assert.equal(result.needsReview,true);assert.equal((await confirm(p.id)).status,409);assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});
});
test('QueryDR verified settled status 20 is received, but still requires employee confirmation',async()=>{
 const p=(await create(await order(),'VNPAY')).body.data;queryMode='settled';
 assert.equal((await request(`/${p.id}/query`,{method:'POST'})).body.data.state,'RECEIVED');assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});await confirm(p.id);assert.equal((await request(`/${p.id}`)).body.data.state,'COMPLETED');
});
test('table listing is branch scoped; per-table list contains only unpaid matching orders and exact snapshots',async()=>{
 const id=await order(),paid=(await create(await order())).body.data;await confirm(paid.id);
 const tables=await request('/tables');assert.equal(tables.status,200);assert.ok(tables.body.data.some(t=>t.name==='Bàn 3'));assert.ok(tables.body.data.every(t=>t.branchId==='demo-branch-a'));
 assert.equal((await request('/tables/demo-table-3/orders',{role:'foreign'})).status,403);
 const rows=(await request('/tables/demo-table-3/orders')).body.data;assert.ok(rows.some(o=>o.id===id));assert.ok(!rows.some(o=>o.id===paid.orderId));assert.ok(rows.every(o=>o.tableId==='demo-table-3'&&o.paymentStatus==='UNPAID'));
 const current=rows.find(o=>o.id===id);assert.equal(current.totalVnd,248000);assert.equal(current.items[0].unitPriceVnd,85000);assert.equal(current.items[0].lineTotalVnd,170000);
 assert.equal((await request(`/orders/${id}?tableId=demo-table-2`)).status,409);
 const context=await orderAdapter(pool).get(id);assert.equal((await request('',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:{orderId:id,tableId:'demo-table-2',method:'CASH',expectedSnapshotHash:snapshotHash(context)}})).status,409);
});
test('changed preview prevents creating an attempt with an old total or wrong table',async()=>{
 const id=await order(),context=await orderAdapter(pool).get(id);
 await pool.execute('UPDATE demo_orders SET items=?,version=version+1 WHERE id=?',[JSON.stringify([{dishNameSnapshot:'Giá snapshot mới',unitPriceVnd:99000,quantity:3}]),id]);
 const result=await request('',{method:'POST',headers:{'Idempotency-Key':randomUUID()},body:{orderId:id,tableId:context.tableId,method:'VNPAY',expectedSnapshotHash:snapshotHash(context)}});assert.equal(result.status,409);assert.equal(result.body.error.code,'ORDER_SNAPSHOT_CHANGED');
 const[[count]]=await pool.execute('SELECT COUNT(*) AS n FROM payments WHERE order_id=?',[id]);assert.equal(count.n,0);
 const fresh=(await request('/quote',{method:'POST',body:{orderId:id}})).body.data;assert.equal(fresh.totalVnd,297000);assert.notEqual(fresh.snapshotHash,snapshotHash(context));
});
test('cash confirmation rechecks item data even if order version was not increased, releases old hold and recalculates',async()=>{
 const id=await order(),p=(await create(id,'CASH','GIAM10')).body.data;
 await pool.execute('UPDATE demo_orders SET items=? WHERE id=?',[JSON.stringify([{dishNameSnapshot:'Đã đổi số lượng',unitPriceVnd:85000,quantity:3}]),id]);
 assert.equal((await request(`/${p.id}`)).body.data.snapshotChanged,true);
 const result=await confirm(p.id);assert.equal(result.status,409);assert.equal(result.body.error.details.refreshOrder,true);assert.equal((await request(`/${p.id}`)).body.data.state,'CANCELLED');assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});
 const fresh=(await create(id,'CASH','GIAM10')).body.data;assert.notEqual(fresh.id,p.id);assert.equal(fresh.totalVnd,229500);await confirm(fresh.id);assert.equal((await request(`/${fresh.id}`)).body.data.state,'COMPLETED');
});
test('table/branch reassignment or payment elsewhere blocks employee completion',async()=>{
 for(const change of ["table_id='demo-table-2'","branch_id='branch-b'","payment_status='PAID'"]){const id=await order(),p=(await create(id)).body.data;await pool.query(`UPDATE demo_orders SET ${change} WHERE id=?`,[id]);assert.equal((await confirm(p.id)).status,409);assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});}
});
test('stale VNPay URL is withheld, pending request blocks new charges; verified failure allows new reference/current amount',async()=>{
 const id=await order(),p=(await create(id,'VNPAY')).body.data;assert.ok(p.paymentUrl);
 await pool.execute('UPDATE demo_orders SET items=?,version=version+1 WHERE id=?',[JSON.stringify([{dishNameSnapshot:'Món đã đổi',unitPriceVnd:99000,quantity:2}]),id]);
 const changed=(await request(`/${p.id}`)).body.data;assert.equal(changed.paymentUrl,null);assert.equal(changed.snapshotChanged,true);
 assert.equal((await create(id,'VNPAY')).status,409);assert.equal((await create(id,'CASH')).status,409);assert.equal((await request(`/${p.id}`)).body.data.state,'PROVIDER_PENDING');
 await ipn(callback(p,{vnp_ResponseCode:'24',vnp_TransactionStatus:'02'}));const next=(await create(id,'VNPAY')).body.data;assert.notEqual(next.reference,p.reference);assert.equal(next.totalVnd,198000);assert.equal(new URL(next.paymentUrl).searchParams.get('vnp_Amount'),'19800000');
});
test('money received for an old snapshot cannot create invoice or be charged again',async()=>{
 const id=await order(),p=(await create(id,'VNPAY')).body.data;await pool.execute('UPDATE demo_orders SET version=version+1 WHERE id=?',[id]);await ipn(callback(p));assert.equal((await confirm(p.id)).status,409);const d=(await request(`/${p.id}`)).body.data;assert.equal(d.needsReview,true);assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});assert.equal((await create(id,'CASH')).status,409);
});
test('table stays occupied until every explicitly selected order is paid; concurrent completion is consistent',async()=>{
 const tableId=`test-table-${randomUUID()}`;await pool.execute('INSERT INTO demo_tables(id,branch_id,name,occupancy) VALUES (?,?,?,?)',[tableId,'demo-branch-a','Bàn kiểm thử','OCCUPIED']);
 const a=await order(),b=await order();await pool.execute('UPDATE demo_orders SET table_id=? WHERE id IN (?,?)',[tableId,a,b]);
 const pa=(await create(a)).body.data;await confirm(pa.id);assert.equal((await tableAdapter(pool).get(tableId)).occupancy,'OCCUPIED');
 const pb=(await create(b)).body.data;await confirm(pb.id);assert.equal((await tableAdapter(pool).get(tableId)).occupancy,'AVAILABLE');await confirm(pb.id);assert.deepEqual(await counts(pb),{invoices:1,revenue_entries:1,voucher_uses:0});
 const c=await order(),d=await order();await pool.execute('UPDATE demo_orders SET table_id=? WHERE id IN (?,?)',[tableId,c,d]);const pc=(await create(c)).body.data,pd=(await create(d)).body.data;await Promise.all([confirm(pc.id),confirm(pd.id)]);assert.equal((await tableAdapter(pool).get(tableId)).occupancy,'AVAILABLE');
});
test('table-owner acknowledgement retries after order ack; no premature invoice',async()=>{
 const id=await order(),p=(await create(id)).body.data;let orderCalls=0,tableCalls=0,online=false;
 const remoteOrders={...orderAdapter(pool),demo:false,markPaid:async()=>{orderCalls++;}},remoteTables={...tableAdapter(pool),demo:false,reconcile:async()=>{tableCalls++;if(!online)throw new Error('table unavailable');}};
 const app=await createPaymentApp(pool,remoteOrders,vnp,remoteTables),account={accountId:'test-employee',branchId:'demo-branch-a'};
 const pending=await app.core.confirm(p.id,{cashReceived:true},account);assert.equal(pending.state,'FINALIZING');assert.deepEqual(await counts(p),{invoices:0,revenue_entries:0,voucher_uses:0});online=true;await app.core.drain(p.id);assert.equal((await request(`/${p.id}`)).body.data.state,'COMPLETED');assert.equal(orderCalls,2);assert.equal(tableCalls,2);
});

test('late success from a failed attempt withholds the active VNPay link during reconciliation',async()=>{const id=await order();const first=(await create(id,'VNPAY')).body.data;await ipn(callback(first,{vnp_ResponseCode:'24',vnp_TransactionStatus:'02'}));const next=(await create(id,'VNPAY')).body.data;assert.ok(next.paymentUrl);await ipn(callback(first));const current=(await request('/'+next.id)).body.data;assert.equal(current.needsReview,true);assert.equal(current.paymentUrl,null);assert.equal((await confirm(next.id)).status,409);assert.deepEqual(await counts(next),{invoices:0,revenue_entries:0,voucher_uses:0});});
