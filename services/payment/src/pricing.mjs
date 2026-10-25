import {ApiError} from '../../../packages/http.mjs';
export function calculate(items,voucher=null){
 if(!Array.isArray(items)||!items.length||items.length>200)throw new ApiError(422,'INVALID_ORDER','Order không có dòng món hợp lệ');
 let subtotal=0n;
 const lines=items.map(item=>{
  if(typeof item.dishNameSnapshot!=='string'||!item.dishNameSnapshot||!Number.isSafeInteger(item.unitPriceVnd)||item.unitPriceVnd<=0||!Number.isSafeInteger(item.quantity)||item.quantity<=0)throw new ApiError(422,'INVALID_ORDER','Số lượng/đơn giá snapshot không hợp lệ');
  const line=BigInt(item.unitPriceVnd)*BigInt(item.quantity);subtotal+=line;
  return {...item,lineTotalVnd:Number(line)};
 });
 if(subtotal>9999999999n)throw new ApiError(422,'AMOUNT_TOO_LARGE','Tổng tiền vượt giới hạn 9.999.999.999 VND');
 let discount=0n;
 if(voucher){
  if(!voucher.active||new Date(voucher.expires_at)<=new Date()||Number(voucher.used_count)+Number(voucher.held_count)>=Number(voucher.max_uses)||subtotal<BigInt(voucher.min_total_vnd))throw new ApiError(422,'VOUCHER_UNAVAILABLE','Voucher hết hạn, hết lượt hoặc chưa đạt mức tối thiểu',{voucherCode:'Voucher không thể sử dụng'});
  discount=voucher.kind==='PERCENT'?subtotal*BigInt(voucher.value)/10000n:BigInt(voucher.value);
  discount=discount>BigInt(voucher.max_discount_vnd)?BigInt(voucher.max_discount_vnd):discount;
 }
 if(discount>=subtotal)throw new ApiError(422,'INVALID_DISCOUNT','Số tiền sau giảm phải lớn hơn 0');
 return {items:lines,subtotalVnd:Number(subtotal),discountVnd:Number(discount),totalVnd:Number(subtotal-discount)};
}
export function voucherCode(value){if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||!/^[-a-zA-Z0-9]{1,40}$/.test(value.trim()))throw new ApiError(422,'INVALID_VOUCHER','Mã voucher không hợp lệ',{voucherCode:'Mã voucher không hợp lệ'});return value.trim().toUpperCase();}
