# Hợp đồng service trong bản tích hợp

## Sơ đồ

~~~mermaid
flowchart LR
  Browser[Web chung] --> Gateway[API Gateway /api/v1]
  Gateway --> Identity[identity-service]
  Gateway --> Menu[menu-service]
  Gateway --> Reservation[reservation/table-service + branches]
  Gateway --> Order[order-service]
  Gateway --> Staff[staff-service]
  Gateway --> Schedule[schedule-service]
  Gateway --> Inventory[inventory-service]
  Gateway --> Payment[payment-service]
  Order --> Menu
  Order --> Reservation
  Reservation --> Order
  Payment --> Order
  Payment --> Reservation
  Order --> Payment
  Staff --> Identity
  Staff --> Schedule
  Staff --> Reservation
  Schedule --> Staff
  Inventory --> Reservation
~~~

Mỗi ô sở hữu schema/user tương ứng *_db / *_app trên MySQL mới, được GRANT riêng. Không có truy vấn/FK liên schema. Reservation là nguồn chính thức của branch/table; staff/inventory giữ branchId tham chiếu. Chỉ identity có private key; Gateway và provider xác minh RS256 và introspection để từ chối tài khoản bị khóa, đổi role/chi nhánh hoặc tokenVersion cũ.

## Quy ước

- JWT: sub=accountId, tokenUse=access, tokenVersion nguyên, role thuộc bốn role đã thống nhất; branchId bắt buộc cho nhân viên; employeeId tham chiếu hồ sơ staff. Issuer restaurant-integrated, audience restaurant-api; access token 15 phút, refresh lưu digest và được rotate. Auth mode identity ở mọi container chính.
- Service-to-service: X-Service-Token đọc từ secret riêng của stack; X-Request-Id dùng truy vết; lệnh ghi có Idempotency-Key. Không forward namespace /internal qua Gateway/web. Bí mật không được gửi đến browser hoặc log.
- VND là số nguyên an toàn; số lượng kho là chuỗi DECIMAL tối đa ba chữ số thập phân. Đơn giá order lấy từ menu khi thêm dòng và được giữ trong order, không JOIN lại menu để tính hóa đơn.
- Payload chung {data:...}; lỗi {error:{code,message,details},requestId}. Gateway chuẩn hóa envelope của staff/schedule gốc. If-Match là version có dấu ngoặc kép; idempotency key phải được giữ nguyên khi retry cùng một lệnh.

## Các API nội bộ thật

| Caller → owner | API / dữ liệu |
|---|---|
| Order → menu | POST /internal/v1/dishes/resolve {dishIds} → data.dishes:[{id,code,name,priceVnd,status}]; tất cả phải ACTIVE |
| Order → reservation | GET /internal/v1/reservations/:id/order-context → id/branchId/tableId/status; GET /internal/v1/tables/:id/order-context → id/branchId/capacity/status |
| Order → reservation | POST /internal/v1/reservations/:id/order-claims {orderId,tableId,branchId}; lock reservation, chỉ CONFIRMED và đúng bàn/chi nhánh. ID order suy ra ổn định từ actor+key để retry create dùng lại intent |
| Reservation → order | GET /internal/v1/reservations/:id/orders → {orders:[{id,status,cancellable}]}; POST /internal/v1/orders/:id/cancel {reservationId,reason}, key reservation-cancel:reservationId:orderId |
| Table → order | GET /internal/v1/table-orders?tableId=... → các order chưa trả tiền và chưa CANCELLED; dùng cho occupancy, bao gồm DRAFT |
| Payment → order | GET /internal/v1/payment-orders?branchId=...&tableId=...&paymentStatus=UNPAID → từng context có items; chỉ SUBMITTED/HANDED_OVER |
| Payment → order | GET /internal/v1/orders/:id/payment-context → context đầy đủ + paidPaymentId khi PAID |
| Payment → order | POST /internal/v1/orders/:id/payment-lock {paymentId,tableId,expectedSnapshotHash,lockId,replacesPaymentId?}; If-Match không cần vì hash bao gồm version; trả snapshot đã freeze |
| Payment → order | POST /internal/v1/orders/:id/mark-paid {paymentId,lockId,branchId,tableId,expectedSnapshot,orderVersion,totalVnd,discountVnd,method}; ack {orderId,paymentId,branchId,tableId,totalVnd,paymentStatus:PAID} |
| Order → payment | GET /internal/v1/payments/:id/status → {id,orderId,branchId,state,totalVnd}; xác minh payment FINALIZING/COMPLETED trước mark-paid hoặc FAILED/CANCELLED trước thay lock cũ |
| Payment → table | GET /internal/v1/branches/:id/tables; GET /internal/v1/tables/:id/payment-context → {id,branchId,name,status,capacity,occupancy,version} |
| Payment → table | POST /internal/v1/tables/:id/payment-completed {paymentId,orderId,branchId}; key=paymentId; ack {tableId,branchId,paymentId,occupancy} |
| Inventory/staff → reservation | GET /internal/v1/branches, GET /internal/v1/branches/:id → {id,name,status,acceptsReservations} |
| Staff → identity | /internal/v1/staff-accounts (POST) và /:employeeId (GET/PATCH/DELETE); tạo/đổi email/role/khóa tài khoản, version tăng để thu hồi access token cũ. Password chỉ là input riêng, không trả lại |
| Staff → schedule | GET /internal/employees/:id/blockers (đường nội bộ của schedule-service gốc), header X-Service-Token |
| Schedule → staff | GET /internal/employees/:id, GET /internal/positions/:id, header X-Service-Token |

Một context order gồm id, code, branchId, tableId, reservationId, status, paymentStatus, version, totalVnd, items:[{id,dishId,dishNameSnapshot,quantity,unitPriceVnd,lineTotalVnd}]. Fingerprint SHA256 chuẩn hóa từ id, branchId, tableId, version, status và nội dung từng dòng; bỏ thông tin lock hoặc thời điểm không liên quan.

## Hoàn tất và retry

Order owner khóa row, kiểm tra UNPAID/branch/table/version/hash và freeze snapshot trước thu tiền. Các thao tác thêm/sửa món bị chặn khi có payment lock. Lệnh mark-paid kiểm tra lại dưới cùng transaction ghi PAID. Nếu đã PAID bởi cùng paymentId, trả ACK đã lưu trước kiểm tra UNPAID; paymentId khác hoặc amount/branch/table khác bị từ chối. Order không lập receipt hoặc ghi doanh thu riêng; route settle đã bị gỡ.

Payment giữ transaction nội bộ, voucher reservation và durable outbox. Nhân viên xác nhận → FINALIZING → order mark-paid → table payment-completed → transaction payment lập invoice/revenue/voucher-use, chuyển COMPLETED. Không có transaction SQL xuyên schema. Nếu bất kỳ owner chưa ACK, giữ FINALIZING để retry, không phát hành chứng từ hoặc thu lại tiền. Unique paymentId/orderId và khóa row ngăn double completion.

Table owner xác nhận order thật đã PAID bởi paymentId tương ứng, rồi kiểm tra các order chưa trả tiền và booking CONFIRMED/CANCEL_PENDING đang diễn ra. Trạng thái bàn được tính từ dữ liệu owner hiện tại, không được payment tự cập nhật bảng của table-service. Có bảng ACK idempotent riêng; một bàn còn order khác vẫn OCCUPIED.

Reservation giữ CANCEL_PENDING khi order-service timeout hoặc create-intent chưa có kết quả. Không suy luận order vắng mặt từ lỗi mạng. DRAFT cancel dùng key ổn định; SUBMITTED/HANDED_OVER không bị hủy. Intent chưa có order do create bị gián đoạn được giữ để retry cùng key; trường hợp caller bỏ hẳn request cần đối soát vận hành, không tự giải phóng bàn khi chưa rõ.

## Public API

Tất cả ở Gateway /api/v1. Public không JWT chỉ có POST /reservations, GET /branches, auth login/refresh/logout, GET payments/vnpay/ipn và display-only return. IPN vẫn kiểm tra HMAC/reference/merchant/amount. Provider khác tự kiểm tra JWT/role/chi nhánh.

Nhóm route: /dishes; /reservations, /branches/:id/tables/availability và /schedule; /tables, /order-reservations (context tối thiểu cho phục vụ); /orders; /payments; /staff/positions, /staff/branches/:id/employees; /schedule/branches/:id/shifts, registrations, assignments, staff-requests; /ingredients, /branches/:id/stock, /transfer-requests, /export-slips, /import-slips. OpenAPI tổng hợp có index đầy đủ và link tới schema chuyên biệt.

Khóa owner được gắn với paymentId cụ thể. PaymentId suy ra ổn định từ actor+Idempotency-Key để retry cùng lệnh không tạo khóa mồ côi mới. POST /internal/v1/orders/:id/payment-unlock chỉ bỏ khóa khi payment owner xác nhận FAILED/CANCELLED và không needsReview, đúng order/lock/paymentId. Cancel tiền mặt gọi unlock sau khi đã commit; worker owner quét các khóa terminal để retry nếu đường truyền lỗi. Lệnh cancel cũ không thể mở khóa một phiên mới. Provider đang chờ/đã nhận tiền không được mở khóa bằng timeout.
