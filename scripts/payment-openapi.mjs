import {writeFileSync} from 'node:fs';
const ref=n=>({$ref:`#/components/schemas/${n}`});
const json=s=>({'application/json':{schema:s}});
const envelope=s=>({type:'object',required:['data'],properties:{data:s}});
const success=s=>({description:'Thành công',content:json(envelope(s))});
const errors=Object.fromEntries([400,401,403,404,409,422,503].map(n=>[n,{description:{400:'Sai đầu vào/header',401:'Chưa xác thực',403:'Sai vai trò/chi nhánh',404:'Không tìm thấy',409:'Xung đột/pending/order đã trả tiền/cần đối soát',422:'Sai nghiệp vụ/voucher',503:'Phụ thuộc chưa cấu hình/không sẵn sàng'}[n],content:json(ref('Error'))}]));
const body=s=>({required:true,content:json(s)});
const id={name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}};
const op=(summary,schema,extra={})=>({summary,security:[{bearerAuth:[]}],responses:{200:success(schema),...errors},...extra});
const money={type:'integer',minimum:0,maximum:9999999999};
const fields={subtotalVnd:money,discountVnd:money,totalVnd:{...money,minimum:1}};
const document={openapi:'3.0.3',info:{title:'Restaurant payment API',version:'1.0.0',description:'CHỈ NHAN_VIEN_TIEP_NHAN, đúng branchId, ngoại trừ IPN/return công khai. CASH và VNPAY Sandbox. Giá snapshot từ order, không nhận tổng tiền từ client. Return không ghi trạng thái. Bản tích hợp dùng order/table owner qua HTTP; adapter demo chỉ dành test.'},servers:[{url:'http://localhost:19081'}],paths:{
 '/api/v1/payments/config':{get:op('Khả năng VNPay và chế độ order demo',{type:'object',properties:{vnpayEnabled:{type:'boolean'},demoOrders:{type:'boolean'}}})},
 '/api/v1/payments/orders':{get:op('Order của chi nhánh trong token',{type:'array',items:ref('Order')})},
 '/api/v1/payments/orders/{id}':{get:op('Order và yêu cầu thanh toán hiện tại',{type:'object',properties:{order:ref('Order'),payment:ref('Payment')}},{parameters:[{...id,schema:{type:'string',maxLength:64}}]})},
 '/api/v1/payments/quote':{post:op('Tính tiền và kiểm tra voucher; chưa tiêu lượt',{type:'object',properties:{order:ref('Order'),items:{type:'array',items:ref('Item')},...fields}},{requestBody:body({type:'object',required:['orderId'],properties:{orderId:{type:'string',maxLength:64},voucherCode:{type:'string',nullable:true,maxLength:40}}})})},
 '/api/v1/payments':{post:op('Tạo/reuse một yêu cầu; pending không cho yêu cầu thu tiền mới',ref('Payment'),{parameters:[{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[-a-zA-Z0-9_]{8,128}$'}}],requestBody:body({type:'object',additionalProperties:false,required:['orderId','method'],properties:{orderId:{type:'string',maxLength:64},method:{type:'string',enum:['CASH','VNPAY']},voucherCode:{type:'string',nullable:true,maxLength:40}}}),responses:{201:success(ref('Payment')),...errors}})},
 '/api/v1/payments/{id}':{get:op('Trạng thái backend, snapshot và invoice đã chốt',ref('Payment'),{parameters:[id]})},
 '/api/v1/payments/{id}/query':{post:op('QueryDR: API success khác với giao dịch đã thanh toán',ref('Payment'),{parameters:[id],description:'Timeout, sai checksum/amount/ref, mã 91 hay trạng thái 01/04/07 giữ nguyên pending. Chỉ kết quả xác thực thành công được chuyển RECEIVED, không tự xuất hóa đơn.'})},
 '/api/v1/payments/{id}/confirm':{post:op('Nhân viên xác nhận hoàn tất; idempotent theo payment/order',ref('Payment'),{parameters:[id],requestBody:body({type:'object',properties:{cashReceived:{type:'boolean',description:'Bắt buộc true cho CASH_PENDING'}}}),description:'CASH_PENDING hoặc RECEIVED. FINALIZING bền vững và outbox tới order; voucher/invoice/revenue/COMPLETED trong một transaction sau ack. Lặp/đồng thời không tạo bản ghi trùng.'})},
 '/api/v1/payments/{id}/cancel':{post:op('Chỉ đóng CASH_PENDING để đổi phương thức',ref('Payment'),{parameters:[id],description:'Không cho hủy VNPay chưa rõ kết quả.'})},
 '/api/v1/payments/{id}/invoice':{get:op('Hóa đơn đã hoàn tất',ref('Invoice'),{parameters:[id]})},
 '/api/v1/payments/by-reference/{ref}':{get:op('Tìm yêu cầu khi quay về từ VNPay, vẫn kiểm tra role/branch',ref('Payment'),{parameters:[{name:'ref',in:'path',required:true,schema:{type:'string'}}]})},
 '/api/v1/payments/vnpay/ipn':{get:{summary:'VNPay IPN; không JWT, bắt buộc checksum và đối chiếu merchant/ref/amount',security:[],parameters:['vnp_TmnCode','vnp_TxnRef','vnp_Amount','vnp_ResponseCode','vnp_TransactionStatus','vnp_TransactionNo','vnp_PayDate','vnp_SecureHash'].map(name=>({name,in:'query',required:true,schema:{type:'string'}})),responses:{200:{description:'RspCode 00 nhận, 02 lặp, 01 không tìm thấy, 04 sai tiền, 97 sai checksum/merchant, 99 lỗi/mâu thuẫn. Không ghi doanh thu/hóa đơn ở IPN.',content:json({type:'object',properties:{RspCode:{type:'string'},Message:{type:'string'}}})}}}},
 '/api/v1/payments/vnpay/return':{get:{summary:'Chỉ hiển thị hướng dẫn; không sửa trạng thái dù payload có chữ ký',security:[],responses:{200:success({type:'object',properties:{message:{type:'string'}}})}}}
},components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'RS256 JWT'}},schemas:{
 Item:{type:'object',required:['dishNameSnapshot','quantity','unitPriceVnd'],properties:{dishNameSnapshot:{type:'string'},quantity:{type:'integer',minimum:1},unitPriceVnd:{type:'integer',minimum:1},lineTotalVnd:money}},
 Order:{type:'object',properties:{id:{type:'string'},code:{type:'string'},branchId:{type:'string'},version:{type:'integer'},status:{type:'string'},paymentStatus:{type:'string',enum:['UNPAID','PAID']},items:{type:'array',items:ref('Item')}}},
 Payment:{type:'object',properties:{id:{type:'string',format:'uuid'},orderId:{type:'string'},branchId:{type:'string'},method:{type:'string',enum:['CASH','VNPAY']},state:{type:'string',enum:['CASH_PENDING','PROVIDER_PENDING','RECEIVED','FAILED','CANCELLED','FINALIZING','COMPLETED']},...fields,voucherCode:{type:'string',nullable:true},reference:{type:'string'},paymentUrl:{type:'string',nullable:true},needsReview:{type:'boolean'},demo:{type:'boolean'},queryOutcome:{type:'string'},order:ref('Order'),invoice:{type:'object',nullable:true,properties:{id:{type:'string'},code:{type:'string'}}}}},
 Invoice:{type:'object',properties:{code:{type:'string'},paymentId:{type:'string'},orderId:{type:'string'},orderCode:{type:'string'},branchId:{type:'string'},method:{type:'string'},items:{type:'array',items:ref('Item')},...fields,voucherCode:{type:'string',nullable:true},createdAt:{type:'string',format:'date-time'},demo:{type:'boolean'}}},
 Error:{type:'object',properties:{error:{type:'object',properties:{code:{type:'string'},message:{type:'string'},details:{type:'object',additionalProperties:true}}},requestId:{type:'string'}}}
}}};
document.info.version='1.1.0';
document.info.description+=' Luồng bắt đầu từ bàn của chi nhánh trong token; không chọn ngầm/gộp order. Snapshot phải được đối chiếu lại lúc tạo/xác nhận; VNPay cũ không được dùng khi snapshot thay đổi.';
document.components.schemas.Table={type:'object',required:['id','branchId','name','status','occupancy'],properties:{id:{type:'string'},branchId:{type:'string'},name:{type:'string'},status:{type:'string'},occupancy:{type:'string',enum:['AVAILABLE','OCCUPIED']},version:{type:'integer'}}};
document.components.schemas.Order.properties.tableId={type:'string'};
Object.assign(document.components.schemas.Payment.properties,{tableId:{type:'string',nullable:true},snapshotHash:{type:'string'},snapshotChanged:{type:'boolean'},validationUnavailable:{type:'boolean'},staleReason:{type:'string',nullable:true}});
Object.assign(document.components.schemas.Invoice.properties,{tableId:{type:'string'},tableName:{type:'string'}});
document.paths['/api/v1/payments/tables']={get:op('Bàn của chi nhánh trong token',{type:'array',items:ref('Table')})};
document.paths['/api/v1/payments/tables/{id}/orders']={get:op('Chỉ order chưa thanh toán của bàn đã chọn; không gộp/tự chọn',{type:'array',items:ref('Order')},{parameters:[{...id,schema:{type:'string',maxLength:64}}]})};
const tableQuery={name:'tableId',in:'query',required:true,schema:{type:'string',maxLength:64}};
document.paths['/api/v1/payments/orders'].get.parameters=[tableQuery];
document.paths['/api/v1/payments/orders/{id}'].get.parameters.push(tableQuery);
const quote=document.paths['/api/v1/payments/quote'].post;
quote.requestBody.content['application/json'].schema.required.push('tableId');
quote.requestBody.content['application/json'].schema.properties.tableId={type:'string',maxLength:64};
quote.responses[200].content['application/json'].schema.properties.data.properties.snapshotHash={type:'string',pattern:'^[a-f0-9]{64}$'};
const create=document.paths['/api/v1/payments'].post.requestBody.content['application/json'].schema;
create.required.push('tableId','expectedSnapshotHash');Object.assign(create.properties,{tableId:{type:'string',maxLength:64},expectedSnapshotHash:{type:'string',pattern:'^[a-f0-9]{64}$',description:'Fingerprint đã nhận khi xem quote. Khác snapshot hiện tại trả 409, phải xem lại order.'}});
document.paths['/api/v1/payments/{id}/confirm'].post.description+=' Kiểm tra lại tableId/branchId, UNPAID và fingerprint món/version/giá; khác trả 409 ORDER_SNAPSHOT_CHANGED. Tiền mặt cũ đóng/giải phóng voucher; VNPay chưa rõ vẫn chờ và chặn thu mới, đã nhận tiền thì cần đối soát. Hoàn tất chỉ sau ack cả order-service và table-service.';
writeFileSync('packages/contracts/payment.openapi.json',JSON.stringify(document,null,2)+'\n');console.log('Payment OpenAPI generated');
