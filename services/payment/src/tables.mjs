import {randomUUID} from 'node:crypto';
import {ApiError,secret} from '../../../packages/http.mjs';
export function tableAdapter(pool){
 const mode=process.env.TABLE_ADAPTER||process.env.ORDER_ADAPTER;
 if(mode==='demo'){
  if(process.env.NODE_ENV==='production')throw new Error('Demo tables forbidden in production');
  const view=r=>({id:r.id,branchId:r.branch_id,name:r.name,status:r.status,occupancy:r.occupancy,version:r.version});
  return {demo:true,
   async list(branchId){const[rows]=await pool.execute("SELECT * FROM demo_tables WHERE branch_id=? AND status='ACTIVE' ORDER BY name",[branchId]);return rows.map(view);},
   async get(id,connection=pool,lock=false){const[[r]]=await connection.execute(`SELECT * FROM demo_tables WHERE id=?${lock?' FOR UPDATE':''}`,[id]);if(!r)throw new ApiError(404,'TABLE_NOT_FOUND','Không tìm thấy bàn');return view(r);},
   async reconcile(p,snapshot,c){
    const table=await this.get(snapshot.tableId,c,true);
    if(table.branchId!==p.branch_id)throw new Error('TABLE_BRANCH_CHANGED');
    const[left]=await c.execute("SELECT id FROM demo_orders WHERE table_id=? AND branch_id=? AND payment_status='UNPAID' AND status IN ('SUBMITTED','HANDED_OVER') FOR UPDATE",[snapshot.tableId,p.branch_id]);
    const occupancy=left.length>0?'OCCUPIED':'AVAILABLE';
    await c.execute('UPDATE demo_tables SET version=version+IF(occupancy<>?,1,0),occupancy=? WHERE id=?',[occupancy,occupancy,table.id]);
   }
  };
 }
 if(mode!=='http'||!process.env.TABLE_BASE_URL||!process.env.TABLE_SERVICE_TOKEN_FILE)throw new Error('Configure authenticated table-service or development demo tables');
 const token=secret('TABLE_SERVICE_TOKEN_FILE');
 async function call(path,body){try{const r=await fetch(`${process.env.TABLE_BASE_URL}/internal/v1${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Service-Token':token,'X-Request-Id':randomUUID(),...(body?{'Idempotency-Key':body.paymentId}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(3000)});if(!r.ok)throw new Error();return(await r.json()).data;}catch{throw new ApiError(503,'TABLE_UNAVAILABLE','Table-service chưa sẵn sàng; chưa thể hoàn tất thanh toán');}}
 return {demo:false,list:branchId=>call(`/branches/${encodeURIComponent(branchId)}/tables`),get:id=>call(`/tables/${encodeURIComponent(id)}/payment-context`),
  async reconcile(p,snapshot){const ack=await call(`/tables/${encodeURIComponent(snapshot.tableId)}/payment-completed`,{paymentId:p.id,orderId:p.order_id,branchId:p.branch_id});if(ack.tableId!==snapshot.tableId||ack.branchId!==p.branch_id||ack.paymentId!==p.id)throw new Error('TABLE_ACK_MISMATCH');}
 };
}
