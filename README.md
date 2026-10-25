# Ứng dụng quản lý chuỗi nhà hàng

Một giao diện web, một API Gateway, tám service Node.js/Express và MySQL 8.4. Bàn và chi nhánh do reservation-service sở hữu; order, payment, menu, nhân viên, lịch làm và kho dùng API thật. Mỗi service có schema/tài khoản DB riêng. Bộ cấu hình này dành cho development/demo, không phải cấu hình production.

## Chạy từ bản clone sạch trên Windows

Cần Git, Docker Desktop đang chạy **Linux containers**, PowerShell 5.1 trở lên và Internet để tải image. Không cần cài MySQL hoặc Node.js trên Windows để chạy ứng dụng và bộ test Docker. Lần build đầu có thể mất vài phút. Repo private: tài khoản GitHub của thành viên phải được cấp quyền trước khi clone.

~~~powershell
git clone https://github.com/NguyenDaiLong19HTTT/Restaurant_Sys.git Restaurant_Integrated
Set-Location Restaurant_Integrated
Copy-Item .env.example .env
notepad .env
# Nếu 19080/19081 đã dùng, đổi WEB_PORT/API_PORT (ví dụ 19180/19181).
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/compose.ps1 ps
Start-Process http://localhost:19080/dang-nhap
~~~

Web mặc định **http://localhost:19080**, Gateway **http://localhost:19081/api/v1**. Khi đổi cổng, dùng số đã điền trong .env. Chỉ bind cổng trên loopback; không publish MySQL. Setup kiểm kê container, volume, network và thử bind cổng trước khi chạy container. Nếu tên project đã có, setup chọn hậu tố mới và thông báo; tên thực tế lưu ở .local/stack.json. Named volume là <project>_integrated_data (ví dụ restaurant-team_integrated_data). Không có container_name cố định.

start.ps1 tạo bí mật ngẫu nhiên tại .local/ bằng một Node helper trong Docker, build/start, chờ healthy, rồi chạy seed riêng. db-init tạo schema/user còn thiếu trên cả volume mới và cũ; mỗi service chạy migration có sổ theo dõi trước khi mở HTTP. Không phụ thuộc docker-entrypoint-initdb.d. Giữ nguyên .local/ cùng volume cho các lần sau; sao lưu cả hai nếu cần phục hồi. Không tự đổi mật khẩu DB đã có volume. Setup không thay bí mật đã tồn tại.

## Tài khoản demo và dữ liệu mẫu

Mật khẩu chung của các tài khoản seed được sinh **riêng cho mỗi bản clone**, lưu ở .local/login-password; không có mật khẩu cố định trong Git. Mở file cục bộ để đọc rồi đóng, không gửi lên nhóm/chat hoặc chụp vào báo cáo:

~~~powershell
notepad .local/login-password
~~~

| Tên đăng nhập | Vai trò | Chi nhánh |
|---|---|---|
| owner | Chủ chuỗi | Toàn chuỗi |
| manager | Quản lý chi nhánh | Quận 1 |
| server | Nhân viên phục vụ | Quận 1 |
| reception | Nhân viên tiếp nhận | Quận 1 |
| manager-b | Quản lý chi nhánh | Thủ Đức |
| reception-b | Nhân viên tiếp nhận | Thủ Đức |

Đây là tài khoản thật trong identity-service: hash mật khẩu, JWT RS256, kiểm tra tài khoản hiện hành ở backend. Dữ liệu mẫu đều hư cấu: ba chi nhánh, bàn, món, hồ sơ nhân viên khớp identity, nguyên liệu/tồn kho và voucher GIAM10/GIAM20K. Bàn 3 Quận 1 có hai order mẫu được tạo/gửi **qua API order thật**; phải chọn rõ từng order khi thanh toán. Giá order là snapshot từng dòng, không đọc lại giá menu để tính hóa đơn cũ.

Seed dùng khóa cố định/INSERT IGNORE hoặc ledger trong transaction, không upsert ghi đè. Seed lại giữ món đã sửa/xóa mềm, tài khoản đã đổi mật khẩu, order đã thanh toán và dữ liệu người dùng. Không tạo sẵn hóa đơn, doanh thu hoặc giao dịch VNPay. Nếu món mẫu đã bị xóa trước khi tạo được order mẫu lần đầu, seed API sẽ báo lỗi; xử lý dữ liệu qua UI, không khôi phục món đã xóa tự động.

~~~powershell
# Dùng được cả khi MySQL đã có dữ liệu; không cần xóa volume.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/seed.ps1
# Khởi động lại bình thường cũng giữ dữ liệu:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/compose.ps1 restart
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/compose.ps1 up -d --wait
~~~

## Thử luồng nghiệp vụ

1. Vào /dat-ban không cần đăng nhập, chọn Quận 1, nhập thông tin hư cấu và giờ nhận bàn trong tương lai để gửi yêu cầu.
2. Đăng nhập reception → /app/dat-ban, chọn yêu cầu và xác nhận/xếp bàn phù hợp.
3. Đăng nhập server → /app/order, chọn bàn/đặt bàn đã xác nhận, thêm món, kiểm tra số lượng rồi gửi order.
4. Đăng nhập reception → /app/thanh-toan: **Chọn bàn → chọn rõ order → xem các món/đơn giá snapshot/tổng tiền → Thanh toán**. Voucher tùy chọn; chọn Tiền mặt, đánh dấu đã nhận đủ tiền rồi xác nhận hoàn tất. Xem hóa đơn; order và bàn được cập nhật qua API chủ sở hữu. Bàn 3 có sẵn hai order để thử nhanh, không tự gộp.
5. owner dùng /app/mon-an để thêm/sửa/xóa mềm món; manager dùng /app/nhan-vien, /app/lich-lam và /app/kho. owner duyệt điều phối kho; manager xác nhận xuất/nhập theo chi nhánh.

Có thể dùng nhiều cửa sổ InPrivate để giữ các vai trò riêng. Các thao tác kiểm thử tạo dữ liệu thật trong stack của bản clone.

## Kiểm thử

Bộ Docker gồm unit, API menu, callback/QueryDR ký giả lập trong test và Playwright Chromium chạy trình duyệt thật qua web/Gateway:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test.ps1
~~~

Để chạy bộ kiểm thử sâu có restart, retry/outage, quyền DB, nhân viên và kho, cài Node.js >=22 trên máy test, rồi chạy trên **bản clone kiểm thử riêng**, không dùng stack có dữ liệu đang thao tác:

~~~powershell
npm ci
npm run test:integration
npm run test:modules
npm run test:outage
~~~

Các test này ghi fixture riêng, có thể restart/recreate payment-service thuộc đúng project của bản clone. Không chạy khi nhóm đang dùng chung stack. Kết quả/screenshot/trace không đưa vào Git; trace đăng nhập đã tắt. Không chạy test tích hợp song song trên cùng stack.

Để kiểm tra dữ liệu bền: tạo một món có tên riêng hoặc hoàn tất một hóa đơn, ghi mã lại; chạy seed hai lần, restart/up như trên, đăng nhập và mở lại đúng mã. Seed không khôi phục trạng thái đã thay đổi. Không dùng lệnh xóa volume để làm sạch dữ liệu.

## Dừng riêng stack này

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/compose.ps1 stop
# Chạy lại cùng cấu hình, cùng volume:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/compose.ps1 up -d --wait
~~~

Wrapper chỉ dùng compose.yaml và .local/compose.env trong bản clone. Không sử dụng docker compose down -v, docker volume rm hoặc prune. Không sửa Compose của dự án khác. Khi cổng bị chiếm, setup dừng trước khi tạo stack; chỉnh .env rồi chạy lại.

## Hợp đồng tích hợp và giới hạn

- [API tổng hợp/OpenAPI](packages/contracts/integration.openapi.json), [bảng API](docs/integration/API-MATRIX.md), [hợp đồng nội bộ](docs/integration/CONTRACTS.md).
- Web dùng /api/v1 qua Gateway; các /internal/v1 chỉ nằm trên network riêng và cần service token. Payment không ghi trực tiếp DB của order/table.
- [VNPay Sandbox](docs/integration/VNPAY.md) mặc định tắt. Cần TMN Code, Hash Secret, tài khoản tester do VNPay cấp và IPN HTTPS công khai. Điền bí mật vào .local/vnpay.json; không commit hay in log. Return URL chỉ hiển thị; IPN/QueryDR phải xác thực chữ ký, số tiền và trạng thái giao dịch. Chưa xác nhận giao dịch Sandbox thật khi thiếu cấu hình.
- Thông báo SMS đặt bàn hiện dùng simulator; không gửi SMS thật.
- Không triển khai production bằng cấu hình demo. Cần bỏ seed/tài khoản mẫu, thiết lập TLS, quản lý bí mật và sao lưu phù hợp.
