# Cấu hình VNPay Sandbox

Chưa có thông tin merchant/tester của nhóm, nên bản đang chạy enabled=false. Đã kiểm thử thuật toán Pay/IPN và QueryDR bằng hash secret sinh riêng trong test; không gọi thu tiền tại VNPay. Không dùng Return làm bằng chứng nhận tiền.

1. Nhận TMN Code, Hash Secret và thông tin tester từ VNPay Sandbox. Không tự đặt mã merchant hay tài khoản thử. Lưu cấu hình vào .local/vnpay.json trên máy demo (không Git/log/chụp màn hình nội dung):

~~~json
{
  "enabled": false,
  "tmnCode": "",
  "hashSecret": "",
  "paymentUrl": "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  "queryUrl": "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction",
  "returnUrl": "",
  "serverIp": ""
}
~~~

Điền merchant/secret thật, public HTTPS return URL và IP thực hợp lệ cho QueryDR, rồi bật enabled=true. Không đổi secret khi còn giao dịch chưa rõ; đối soát trước khi xoay khóa.

2. Tạo HTTPS reverse proxy/tunnel được nhóm quản lý. Cấu hình IPN merchant trỏ tới https://<demo-host>/api/v1/payments/vnpay/ipn; chỉ route chính xác này tới 127.0.0.1:19081/api/v1/payments/vnpay/ipn. Endpoint GET không JWT nhưng bắt buộc chữ ký và dữ liệu giao dịch đúng. Tắt access log URL callback ở reverse proxy; code/nginx trong web đã tắt log cho IPN. Không public MySQL, port service hoặc /internal.

Return URL có thể trỏ tới route HTTPS chỉ hiển thị thông báo từ /api/v1/payments/vnpay/return, hoặc dùng web HTTPS đầy đủ ở /app/thanh-toan/ket-qua nếu hạ tầng demo có HTTPS cho ứng dụng. Không đổi PAID từ tham số Return. Nhân viên mở web nội bộ để đọc trạng thái backend/QueryDR. Chỉ public những route/asset thực sự cần cho cấu hình demo đã chọn.

3. Recreate đúng payment-service sau đổi config:

~~~powershell
powershell -NoProfile -File scripts/compose.ps1 up --build --no-deps -d --wait payment-service
~~~

4. Thử thanh toán order thật chưa trả tiền, đúng tổng sau voucher. Tiền về từ IPN hoặc QueryDR đã xác thực → RECEIVED; nhân viên xác nhận mới hoàn tất. ResponseCode của QueryDR thành công chỉ xác nhận truy vấn thành công, còn TransactionStatus mới quyết định giao dịch đã nhận tiền hay còn chờ. Timeout/kết quả không xác minh được giữ pending; không tạo yêu cầu thu khác. Callback lặp không tạo hóa đơn/lượt voucher/doanh thu trùng.

Tài liệu gốc: [Pay và IPN](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html), [QueryDR](https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr%26refund.html). Cần chạy giao dịch Sandbox thật sau khi nhóm cung cấp đủ thông tin và HTTPS; kết quả test hiện tại không thay thế bước đó.
