# Đối chiếu mã nguồn và hợp đồng

Ngày kiểm tra: 25/10/2026. Datban.zip có reservation cập nhật 25/10 và inventory 22/10; **36 file inventory giống hệt kho.zip, không có khác biệt**, chỉ giữ một bản. Order.zip có identity RS256 và order; bỏ các fixture dev menu/reservation và thao tác settle. Nhanvien.zip cung cấp staff/schedule; không chạy identity HS256 hoặc Gateway/web riêng của gói. Giao diện được đưa vào web nền Restaurant_Sys.

| Kết nối | Có sẵn trong nguồn | Bên gọi cần / điểm lệch | Kết quả tích hợp |
|---|---|---|---|
| Login | order identity RS256, staff identity HS256, Gateway demo RS256 | identity order thiếu aud và tokenUse; các middleware chưa kiểm tra tài khoản bị khóa đồng nhất | Một identity RS256; sub=accountId, role, branchId, employeeId, tokenVersion, tokenUse=access; iss restaurant-integrated, aud restaurant-api, exp 15 phút; introspection mỗi request |
| Staff role | OWNER/MANAGER/EMPLOYEE, ID chi nhánh 0000... | Bốn role tiếng Việt và ID chi nhánh thật | Chuẩn hóa role; nhân viên có hồ sơ staff, account ở identity; thay vị trí đổi role và thu hồi token cũ |
| Internal auth | X-Service-Token, X-Internal-Service-Token, X-Internal-Token, x-internal-key | Caller/provider không khớp | X-Service-Token thống nhất, bí mật sinh riêng cho stack mới, không đưa ra frontend |
| Order → menu | POST /internal/v1/dishes/resolve | Order cần data.dishes / priceVnd / ACTIVE | Header khớp; resolve món thật; lưu snapshot tên/giá từng dòng, giá mới không sửa dòng cũ |
| Order → reservation | GET reservations/:id/order-context và tables/:id/order-context | Tạo chỉ bằng reservationId từng không lưu tableId suy ra; race tạo order lúc hủy | Lưu tableId đã resolve; đăng ký intent order dưới khóa reservation trước insert; CANCEL_PENDING không bị hiểu là không có order |
| Reservation → order | GET reservations/:id/orders, POST orders/:id/cancel | Hủy chỉ DRAFT, timeout cần retry ổn định | Cùng header; API thật, key reservation-cancel; SUBMITTED bị chặn; giữ bàn khi chưa rõ kết quả |
| Payment → order | Không có payment-context/list/lock/mark-paid trong ZIP | Hợp đồng ORDER-CONTRACT/TABLE-CHECKOUT | Thêm đủ API; freeze snapshot tại owner; mark-paid kiểm tra snapshot/branch/table/UNPAID và paymentId; retry trả ACK cũ |
| Payment → table | Chỉ có table order-context | Danh sách bàn theo branch, payment-context, payment-completed | Thêm API thật; table-service tự đọc trạng thái order qua HTTP và xem đặt bàn hiện tại; không giải phóng khi còn order/đặt bàn |
| Thu tiền | Order tự settle tiền mặt và ghi order_payments | Payment là nơi duy nhất có giao dịch/hóa đơn/voucher/doanh thu | Gỡ route/logic settle; order chỉ lưu PAID + paymentId + ACK tham chiếu |
| Inventory → branch | mock-core chi nhánh | Nguồn chi nhánh chính thức | reservation/table-service sở hữu bảng branches; inventory xác thực chi nhánh qua HTTP |
| Staff → identity/schedule | /internal/accounts và role cũ; FK local branch riêng | Không được truy vấn schema ngoài, đổi/khóa account thật | API identity /internal/v1/staff-accounts; bỏ bản sao branch, lấy branch qua HTTP; schedule gọi staff qua HTTP |
| Frontend | Nhiều ứng dụng, route /api và /api/v1 lẫn nhau | Một web/Gateway, chọn bàn trước thanh toán | Một shell, route theo role, tất cả fetch /api/v1 qua Gateway; không forward /internal |
| Dữ liệu / trạng thái | ID branch/table khác nhau giữa các fixture | Một Bàn 3, một branch cho order/payment | Branch A 11111111-1111-4111-8111-111111111111; B 22222222-2222-4222-8222-222222222222; Bàn 3 A 70000000-0000-4000-8000-000000000103; order/dish ID lấy từ API |
| Migration | DDL nhiều statement, trigger với collation khác schema; staff FK branch riêng | Khởi động lại không reset DB | Parser chạy từng constraint/trigger an toàn khi DDL gián đoạn; migration sửa collation biến trigger; staff/schedule migration own schema |

Order lifecycle DRAFT → SUBMITTED → HANDED_OVER (mang đi), CANCELLED chỉ từ DRAFT; paymentStatus tách UNPAID/PAID. Mark-paid không đổi giá, tên hoặc version của snapshot order. Món ACTIVE/DELETED thuộc menu. Đặt bàn PENDING/CONFIRMED/CANCEL_PENDING/CANCELLED thuộc reservation. Các trạng thái giao dịch thuộc payment.

Các README của ZIP chứa lệnh reset volume hoặc stack demo riêng chỉ được đọc như tài liệu nguồn; không dùng để thao tác stack cũ. Bản tích hợp dùng các lệnh an toàn ở README gốc của thư mục mới.
