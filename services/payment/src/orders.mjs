import {ApiError,secret} from '../../../packages/http.mjs';
import {json} from './db.mjs';
import {randomUUID} from 'node:crypto';
const view=row=>({id:row.id,code:row.code,branchId:row.branch_id,tableId:row.table_id,items:json(row.items),version:row.version,status:row.status,paymentStatus:row.payment_status,paidPaymentId:row.paid_payment_id});
export function orderAdapter(pool){
 const mode=process.env.ORDER_ADAPTER;
 if(mode==='demo'){
  if(process.env.NODE_ENV==='production')throw new Error('Demo orders forbidden in production');
  return {demo:true,
   async list(branchId,tableId){const[rows]=await pool.execute(`SELECT * FROM demo_orders WHERE branch_id=?${tableId?" AND table_id=? AND payment_status='UNPAID' AND status IN ('SUBMITTED','HANDED_OVER')":''} ORDER BY code`,tableId?[branchId,tableId]:[branchId]);return rows.map(view);},
   async get(id,connection=pool,lock=false){const[[r]]=await connection.execute(`SELECT * FROM demo_orders WHERE id=?${lock?' FOR UPDATE':''}`,[id]);if(!r)throw new ApiError(404,'ORDER_NOT_FOUND','Không tìm thấy order demo');return view(r);},
   async lock(id){return this.get(id);}
  };
 }
 if(mode!=='http'||!process.env.ORDER_BASE_URL||!process.env.ORDER_SERVICE_TOKEN_FILE)throw new Error('Configure ORDER_ADAPTER=http and an authenticated order-service');
 const token=secret('ORDER_SERVICE_TOKEN_FILE');
 async function call(path,body){try{const r=await fetch(`${process.env.ORDER_BASE_URL}/internal/v1${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Service-Token':token,'X-Request-Id':randomUUID(),...(body?{'Idempotency-Key':path.endsWith('/payment-lock')?body.lockId:body.paymentId||body.lockId}: {})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(3000)});if(!r.ok)throw new Error('ORDER_REJECTED');return(await r.json()).data;}catch{throw new ApiError(503,'ORDER_UNAVAILABLE','Order-service chưa sẵn sàng; trạng thái đang chờ đối soát');}}
 return {demo:false,list:(branchId,tableId)=>call(`/payment-orders?branchId=${encodeURIComponent(branchId)}${tableId?`&tableId=${encodeURIComponent(tableId)}&paymentStatus=UNPAID`:''}`),get:id=>call(`/orders/${encodeURIComponent(id)}/payment-context`),async lock(id,options){const lockId=`checkout-${id}-${options.expectedSnapshotHash.slice(0,12)}`,data=await call(`/orders/${encodeURIComponent(id)}/payment-lock`,{...options,lockId});return {...data,paymentLockId:lockId};},
  async unlock(p,snapshot){await call('/orders/'+encodeURIComponent(p.order_id)+'/payment-unlock',{paymentId:p.id,lockId:snapshot.paymentLockId});},
  async markPaid(p,snapshot){const ack=await call(`/orders/${encodeURIComponent(p.order_id)}/mark-paid`,{paymentId:p.id,lockId:snapshot.paymentLockId||`checkout-${p.order_id}`,branchId:snapshot.branchId,tableId:snapshot.tableId,expectedSnapshot:snapshot,orderVersion:snapshot.version,totalVnd:Number(p.total_vnd),discountVnd:Number(p.discount_vnd),method:p.method});if(ack.orderId!==p.order_id||ack.paymentId!==p.id||ack.paymentStatus!=='PAID'||ack.totalVnd!==Number(p.total_vnd)||ack.tableId!==snapshot.tableId||ack.branchId!==snapshot.branchId)throw new Error('ORDER_ACK_MISMATCH');}
 };
}
