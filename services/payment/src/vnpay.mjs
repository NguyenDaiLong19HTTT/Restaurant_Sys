import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isIP} from 'node:net';
import {ApiError} from '../../../packages/http.mjs';
export const queryRequestFields=['vnp_RequestId','vnp_Version','vnp_Command','vnp_TmnCode','vnp_TxnRef','vnp_TransactionDate','vnp_CreateDate','vnp_IpAddr','vnp_OrderInfo'];
export const queryResponseFields=['vnp_ResponseId','vnp_Command','vnp_ResponseCode','vnp_Message','vnp_TmnCode','vnp_TxnRef','vnp_Amount','vnp_BankCode','vnp_PayDate','vnp_TransactionNo','vnp_TransactionType','vnp_TransactionStatus','vnp_OrderInfo','vnp_PromotionCode','vnp_PromotionAmount'];
const enc=s=>encodeURIComponent(String(s)).replace(/%20/g,'+').replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const canonical=params=>Object.keys(params).filter(k=>k.startsWith('vnp_')&&!['vnp_SecureHash','vnp_SecureHashType'].includes(k)).sort().map(k=>`${enc(k)}=${enc(params[k])}`).join('&');
export const hmac=(text,key)=>createHmac('sha512',key).update(text,'utf8').digest('hex');
export const signParameters=(params,key)=>hmac(canonical(params),key);
export const signFields=(params,fields,key)=>hmac(fields.map(k=>params[k]??'').join('|'),key);
function equal(a,b){return typeof a==='string'&&/^[0-9a-f]{128}$/i.test(a)&&timingSafeEqual(Buffer.from(a.toLowerCase()),Buffer.from(b));}
export const verifyParameters=(params,key)=>equal(params.vnp_SecureHash,signParameters(params,key));
export const verifyQuery=(params,key)=>equal(params.vnp_SecureHash,signFields(params,queryResponseFields,key));
export function providerParams(url){const result={};for(const[k,v]of new URL(url,'http://localhost').searchParams){if(!k.startsWith('vnp_'))continue;if(Object.hasOwn(result,k)||v.length>2048)throw new ApiError(400,'INVALID_PROVIDER_DATA','Trường VNPay trùng hoặc quá dài');result[k]=v;}return result;}
export function vnTime(date=new Date()){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date).replace(/[- :]/g,'');}
export function loadConfig(){
 let c;try{c=JSON.parse(readFileSync(process.env.VNPAY_CONFIG_FILE,'utf8'));}catch{throw new Error('VNPay configuration cannot be read or parsed; inspect the secret file locally');}
 if(!c.enabled)return {enabled:false};
 if(!/^[A-Z0-9]{8}$/.test(c.tmnCode)||typeof c.hashSecret!=='string'||c.hashSecret.length<16)throw new Error('Valid VNPay Sandbox merchant configuration required');
 for(const[key,path]of [['paymentUrl','/paymentv2/vpcpay.html'],['queryUrl','/merchant_webapi/api/transaction']]){const u=new URL(c[key]);if(u.protocol!=='https:'||u.hostname!=='sandbox.vnpayment.vn'||u.pathname!==path||u.search||u.username)throw new Error('Only official VNPay Sandbox endpoints are allowed');}
 const returnUrl=new URL(c.returnUrl);if(returnUrl.protocol!=='https:')throw new Error('VNPay Sandbox requires a public HTTPS return URL');
 if(!isIP(c.serverIp))throw new Error('VNPay serverIp must be configured');
 return c;
}
export function provider(config,transport=fetch){
 return {
  enabled:Boolean(config.enabled),config,
  paymentUrl(p){
   if(!config.enabled)throw new ApiError(503,'VNPAY_NOT_CONFIGURED','Chưa có cấu hình VNPay Sandbox');
   const params={vnp_Version:'2.1.0',vnp_Command:'pay',vnp_TmnCode:config.tmnCode,vnp_Amount:String(BigInt(p.total_vnd)*100n),vnp_CurrCode:'VND',vnp_TxnRef:p.txn_ref,vnp_OrderInfo:`Thanh toan ${p.txn_ref}`,vnp_OrderType:'other',vnp_Locale:'vn',vnp_ReturnUrl:config.returnUrl,vnp_IpAddr:p.client_ip||config.serverIp,vnp_CreateDate:p.provider_created_at,vnp_ExpireDate:p.expires_at};
   return `${config.paymentUrl}?${canonical(params)}&vnp_SecureHash=${signParameters(params,config.hashSecret)}`;
  },
  async query(p,id=randomUUID().replaceAll('-','')){
   if(!config.enabled)throw new ApiError(503,'VNPAY_NOT_CONFIGURED','Chưa cấu hình VNPay');
   const body={vnp_RequestId:id,vnp_Version:'2.1.0',vnp_Command:'querydr',vnp_TmnCode:config.tmnCode,vnp_TxnRef:p.txn_ref,vnp_TransactionDate:p.provider_created_at,vnp_CreateDate:vnTime(),vnp_IpAddr:config.serverIp,vnp_OrderInfo:`Truy van ${p.txn_ref}`};
   body.vnp_SecureHash=signFields(body,queryRequestFields,config.hashSecret);
   const response=await transport(config.queryUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(7000),redirect:'error'});
   if(!response.ok)throw new Error('QUERY_TRANSPORT_ERROR');
   const data=await response.json();if(!verifyQuery(data,config.hashSecret))throw new Error('QUERY_SIGNATURE_INVALID');
   if(data.vnp_Command!=='querydr'||data.vnp_TmnCode!==config.tmnCode)throw new Error('QUERY_MERCHANT_MISMATCH');
   // API success only means QueryDR worked. Payment status must be checked separately.
   return data;
  }
 };
}
