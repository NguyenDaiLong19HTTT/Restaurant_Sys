# Identity service

Service sở hữu tài khoản nhân sự, mật khẩu, vai trò và phiên đăng nhập. Web gọi API qua Gateway; không có API tự đăng ký. Nhân viên được staff-service tạo ở trạng thái `PENDING`, rồi staff kích hoạt sau khi liên kết hồ sơ hoàn tất.

## Chạy local

1. Tạo database `identity_db` và user riêng cho service, sau đó chạy `migrations/001-create-identity-schema.sql`.
2. Tạo cặp khóa RSA 2048-bit hoặc lớn hơn. Cấp private key chỉ cho Identity; Gateway và các service chỉ cần public key.
3. Sao chép `.env.example` thành `.env`, điền DB, đường dẫn khóa và bootstrap credentials riêng.
4. Chạy `npm install`, sau đó `npm start`.
5. Định tuyến Gateway `/api/v1/auth/**` đến Identity. Cấu hình gateway/order cùng public key RS256 và issuer `restaurant-identity`.

Khi `BOOTSTRAP_USERNAME` và `BOOTSTRAP_PASSWORD` được đặt, lần khởi động đầu tự tạo duy nhất tài khoản chủ chuỗi `ACTIVE`. Đổi mật khẩu ngay sau lần đăng nhập đầu; xóa bootstrap credentials khỏi môi trường sau đó. Đây là bootstrap có kiểm soát, không phải đăng ký công khai.

Nhân viên được provision qua mạng nội bộ: `POST /internal/v1/accounts` với `X-Internal-Service-Token`, `Idempotency-Key` và `{employeeId, role, branchId, username}`. Phản hồi trả mật khẩu tạm một lần (có thể nhận lại cùng key để phục hồi phản hồi); hồ sơ phải được staff-service liên kết và kích hoạt bằng `/internal/v1/accounts/{id}/activate`. Không đưa endpoint `/internal` qua Gateway công khai.

## Bảo mật phiên

- Mật khẩu băm bằng scrypt với salt riêng; không lưu mật khẩu thô.
- Access token RS256 mặc định sống 15 phút; refresh token ngẫu nhiên chỉ lưu dưới dạng SHA-256 và được rotate mỗi lần refresh.
- Đổi mật khẩu và khóa tài khoản tăng `token_version`; mọi refresh token hiện có bị thu hồi. `/auth/me` từ chối access token cũ hoặc tài khoản không ACTIVE.
- Tài khoản nhân viên phải có `employeeId` và `branchId`; chủ chuỗi không có hai trường này.
- Mật khẩu mới tối thiểu 10 ký tự. Không log credentials hoặc token.

Các route công khai và payload xem trong `openapi.yaml`.
