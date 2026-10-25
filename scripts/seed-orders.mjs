// Development fixture creation uses public owner APIs; never writes another schema.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
if(process.env.NODE_ENV!=='development')throw Error('Demo orders require development');
const base='http://api-gateway:3000/api/v1',password=fs.readFileSync('/run/secrets/login_password','utf8').trim();
async function call(path,token,body,headers={}){
 const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 const data=await r.json();if(!r.ok){const e=Error('Owner API returned '+r.status+' for '+path);e.status=r.status;throw e;}return data.data??data;
}
const login=await call('/auth/login',null,{username:'server',password}),token=login.accessToken;
const account=login.account;
for(const [key,items] of [
 ['demo-table3-order-a-v1',[{dishId:'11111111-1111-4111-8111-111111111111',quantity:2},{dishId:'33333333-3333-4333-8333-333333333333',quantity:1}]],
 ['demo-table3-order-b-v1',[{dishId:'22222222-2222-4222-8222-222222222222',quantity:1}]]
]){
 const raw=createHash('sha256').update(account.id+':POST:/orders:'+key).digest('hex');
 const id=raw.slice(0,8)+'-'+raw.slice(8,12)+'-4'+raw.slice(13,16)+'-8'+raw.slice(17,20)+'-'+raw.slice(20,32);
 try{await call('/orders/'+id,token);console.log('Keep existing demo order '+id);continue;}catch(e){if(e.status!==404)throw e;}
 const order=await call('/orders',token,{serviceType:'DINE_IN',tableId:'70000000-0000-4000-8000-000000000103',items},{'Idempotency-Key':key});
 await call('/orders/'+order.id+'/submit',token,{}, {'Idempotency-Key':key+'-submit','If-Match':String(order.version)});
 console.log('Created real demo order '+order.id);
}
