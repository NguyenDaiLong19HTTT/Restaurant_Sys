import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {calculate,voucherCode} from '../services/payment/src/pricing.mjs';
import {canonical,signParameters,verifyParameters,signFields,verifyQuery,queryResponseFields,queryRequestFields,vnTime,providerParams} from '../services/payment/src/vnpay.mjs';
test('payment uses integer order snapshots, voucher bps floors and caps; no floats',()=>{
 const items=[{dishNameSnapshot:'A',unitPriceVnd:85000,quantity:2},{dishNameSnapshot:'B',unitPriceVnd:39000,quantity:2}];
 const voucher={active:1,expires_at:'2099-01-01',used_count:0,held_count:0,max_uses:5,min_total_vnd:100000,kind:'PERCENT',value:1000,max_discount_vnd:30000};
 assert.deepEqual(calculate(items,voucher),{items:[{...items[0],lineTotalVnd:170000},{...items[1],lineTotalVnd:78000}],subtotalVnd:248000,discountVnd:24800,totalVnd:223200});
 assert.equal(calculate([{dishNameSnapshot:'X',unitPriceVnd:999999,quantity:1}],voucher).discountVnd,30000);
 for(const bad of [0,-1,1.1,'2'])assert.throws(()=>calculate([{dishNameSnapshot:'X',unitPriceVnd:85000,quantity:bad}]));
 assert.throws(()=>calculate(items,{...voucher,held_count:5}));assert.throws(()=>calculate(items,{...voucher,expires_at:'2000-01-01'}));assert.throws(()=>calculate([{dishNameSnapshot:'X',unitPriceVnd:Number.MAX_SAFE_INTEGER,quantity:2}]));
 assert.equal(voucherCode(' giam10 '),'GIAM10');assert.throws(()=>voucherCode({}));
});
test('VNPay Pay/IPN canonicalization is sorted form encoding and signed using HMAC SHA512',()=>{
 const params={vnp_TxnRef:'abc',vnp_OrderInfo:'Thanh toan A + B',vnp_Amount:'22320000'};
 const expected='vnp_Amount=22320000&vnp_OrderInfo=Thanh+toan+A+%2B+B&vnp_TxnRef=abc';
 assert.equal(canonical(params),expected);const key='test-only-key';
 assert.equal(signParameters(params,key),createHmac('sha512',key).update(expected).digest('hex'));
 const signed={...params,vnp_SecureHash:signParameters(params,key)};assert.equal(verifyParameters(signed,key),true);assert.equal(verifyParameters({...signed,vnp_Amount:'1'},key),false);
 assert.throws(()=>providerParams('/ipn?vnp_TxnRef=a&vnp_TxnRef=b'));
 assert.equal(vnTime(new Date('2026-10-22T07:08:09Z')),'20261022140809');
});
test('QueryDR uses pipe-joined fields, including empty promotion fields, not Pay URL algorithm',()=>{
 const d={vnp_ResponseId:'r',vnp_Command:'querydr',vnp_ResponseCode:'00',vnp_Message:'Success',vnp_TmnCode:'TESTONLY',vnp_TxnRef:'a',vnp_Amount:'10000',vnp_BankCode:'NCB',vnp_PayDate:'20261022140809',vnp_TransactionNo:'123',vnp_TransactionType:'01',vnp_TransactionStatus:'01',vnp_OrderInfo:'Query'};
 const expected='r|querydr|00|Success|TESTONLY|a|10000|NCB|20261022140809|123|01|01|Query||';
 const key='test-only-key';assert.equal(signFields(d,queryResponseFields,key),createHmac('sha512',key).update(expected).digest('hex'));
 assert.equal(verifyQuery({...d,vnp_SecureHash:signFields(d,queryResponseFields,key)},key),true);
 assert.equal(verifyQuery({...d,vnp_SecureHash:signParameters(d,key)},key),false);
 assert.equal(queryRequestFields.join('|'),'vnp_RequestId|vnp_Version|vnp_Command|vnp_TmnCode|vnp_TxnRef|vnp_TransactionDate|vnp_CreateDate|vnp_IpAddr|vnp_OrderInfo');
});
