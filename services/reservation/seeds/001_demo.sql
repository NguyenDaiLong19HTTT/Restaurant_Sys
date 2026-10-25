-- Demo data (SEED_DEMO_DATA=true). Branch / account IDs must match branch-service and identity seeds.
-- B1 = 11111111-...  Chi nhánh Quận 1      (nhận đặt bàn)
-- B2 = 22222222-...  Chi nhánh Thủ Đức     (nhận đặt bàn)
-- B3 = 33333333-...  Chi nhánh Bình Thạnh  (tạm ngừng nhận đặt bàn, acceptsReservations=false)
-- Booking times are relative to the day the seed runs so the demo bookings are always in the future.
START TRANSACTION;

-- Local (UTC+7) calendar days: tomorrow and the day after.
SET @d1 := DATE(UTC_TIMESTAMP() + INTERVAL 7 HOUR) + INTERVAL 1 DAY;
SET @d2 := @d1 + INTERVAL 1 DAY;
SET @r1_start := TIMESTAMP(@d1, '18:00:00') - INTERVAL 7 HOUR;
SET @r2_start := TIMESTAMP(@d1, '19:00:00') - INTERVAL 7 HOUR;
SET @r3_start := TIMESTAMP(@d1, '12:00:00') - INTERVAL 7 HOUR;
SET @r4_start := TIMESTAMP(@d1, '19:30:00') - INTERVAL 7 HOUR;
SET @r5_start := TIMESTAMP(@d2, '11:30:00') - INTERVAL 7 HOUR;
SET @r6_start := TIMESTAMP(@d2, '18:00:00') - INTERVAL 7 HOUR;
SET @created := UTC_TIMESTAMP(3) - INTERVAL 2 HOUR;

INSERT INTO tables (id, branch_id, code, name, capacity, location) VALUES
  ('70000000-0000-4000-8000-000000000101', '11111111-1111-4111-8111-111111111111', 'T01', 'Bàn 1', 2, 'Cạnh cửa sổ'),
  ('70000000-0000-4000-8000-000000000102', '11111111-1111-4111-8111-111111111111', 'T02', 'Bàn 2', 4, 'Tầng trệt'),
  ('70000000-0000-4000-8000-000000000103', '11111111-1111-4111-8111-111111111111', 'T03', 'Bàn 3', 4, 'Tầng trệt'),
  ('70000000-0000-4000-8000-000000000104', '11111111-1111-4111-8111-111111111111', 'T04', 'Bàn 4', 6, 'Tầng 1'),
  ('70000000-0000-4000-8000-000000000105', '11111111-1111-4111-8111-111111111111', 'VIP1', 'Phòng VIP 1', 10, 'Tầng 1, phòng riêng'),
  ('70000000-0000-4000-8000-000000000201', '22222222-2222-4222-8222-222222222222', 'T01', 'Bàn 1', 2, 'Sân vườn'),
  ('70000000-0000-4000-8000-000000000202', '22222222-2222-4222-8222-222222222222', 'T02', 'Bàn 2', 4, 'Sân vườn'),
  ('70000000-0000-4000-8000-000000000203', '22222222-2222-4222-8222-222222222222', 'T03', 'Bàn 3', 8, 'Trong nhà'),
  ('70000000-0000-4000-8000-000000000301', '33333333-3333-4333-8333-333333333333', 'T01', 'Bàn 1', 4, NULL),
  ('70000000-0000-4000-8000-000000000302', '33333333-3333-4333-8333-333333333333', 'T02', 'Bàn 2', 4, NULL);

INSERT INTO customers (id, full_name, phone, created_at) VALUES
  ('71000000-0000-4000-8000-000000000001', 'Nguyễn Văn An',    '0901234567', @created),
  ('71000000-0000-4000-8000-000000000002', 'Trần Thị Bình',    '0912345678', @created),
  ('71000000-0000-4000-8000-000000000003', 'Lê Hoàng Cường',   '0987654321', @created),
  ('71000000-0000-4000-8000-000000000004', 'Phạm Thu Dung',    '0356789012', @created),
  ('71000000-0000-4000-8000-000000000005', 'Võ Minh Em',       '0778123456', @created),
  ('71000000-0000-4000-8000-000000000006', 'Đặng Gia Huy',     '0889001122', @created);

-- Every booking starts PENDING (trigger trg_res_before_insert); confirmed/cancelled ones move on below.
INSERT INTO reservations (id, code, customer_id, branch_id, starts_at, ends_at, party_size, service_type, created_at) VALUES
  ('72000000-0000-4000-8000-000000000001', 'DB-DEMO-0001', '71000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', @r1_start, @r1_start + INTERVAL 120 MINUTE, 4, 'DINE_IN',   @created),
  ('72000000-0000-4000-8000-000000000002', 'DB-DEMO-0002', '71000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', @r2_start, @r2_start + INTERVAL 120 MINUTE, 2, 'DINE_IN',   @created),
  ('72000000-0000-4000-8000-000000000003', 'DB-DEMO-0003', '71000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', @r3_start, @r3_start + INTERVAL 120 MINUTE, 6, 'PRE_ORDER', @created),
  ('72000000-0000-4000-8000-000000000004', 'DB-DEMO-0004', '71000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', @r4_start, @r4_start + INTERVAL 120 MINUTE, 2, 'DINE_IN',   @created),
  ('72000000-0000-4000-8000-000000000005', 'DB-DEMO-0005', '71000000-0000-4000-8000-000000000005', '22222222-2222-4222-8222-222222222222', @r5_start, @r5_start + INTERVAL 120 MINUTE, 3, 'DINE_IN',   @created),
  ('72000000-0000-4000-8000-000000000006', 'DB-DEMO-0006', '71000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', @r6_start, @r6_start + INTERVAL 120 MINUTE, 4, 'DINE_IN',   @created);

-- DB-DEMO-0002: Bàn 1 (2 chỗ); mock order-service has a DRAFT order on it -> cancelling cancels the order too.
-- DB-DEMO-0004 (19:30, 2 khách) overlaps it, so Bàn 1 shows as busy when confirming DB-DEMO-0004.
UPDATE reservations
   SET status = 'CONFIRMED', table_id = '70000000-0000-4000-8000-000000000101',
       confirmed_by = 'f0000000-0000-4000-8000-000000000006', confirmed_at = @created + INTERVAL 30 MINUTE, version = version + 1
 WHERE id = '72000000-0000-4000-8000-000000000002';

-- DB-DEMO-0003: Bàn 4; mock order-service has a SUBMITTED order on it -> cancellation is refused (BR024).
UPDATE reservations
   SET status = 'CONFIRMED', table_id = '70000000-0000-4000-8000-000000000104',
       confirmed_by = 'f0000000-0000-4000-8000-000000000006', confirmed_at = @created + INTERVAL 40 MINUTE, version = version + 1
 WHERE id = '72000000-0000-4000-8000-000000000003';

UPDATE reservations
   SET status = 'CANCELLED', cancel_reason = 'Khách gọi điện báo đổi lịch sang tuần sau',
       cancelled_by = 'f0000000-0000-4000-8000-000000000006', cancel_requested_at = @created + INTERVAL 50 MINUTE,
       cancelled_at = @created + INTERVAL 50 MINUTE, version = version + 1
 WHERE id = '72000000-0000-4000-8000-000000000006';

INSERT INTO audit_logs (reservation_id, action, from_status, to_status, actor_account_id, actor_role, actor_branch_id, details, created_at) VALUES
  ('72000000-0000-4000-8000-000000000001', 'CREATED', NULL, 'PENDING', 'public', 'KHACH_HANG', NULL, '{"partySize":4,"serviceType":"DINE_IN"}', @created),
  ('72000000-0000-4000-8000-000000000002', 'CREATED', NULL, 'PENDING', 'public', 'KHACH_HANG', NULL, '{"partySize":2,"serviceType":"DINE_IN"}', @created),
  ('72000000-0000-4000-8000-000000000002', 'CONFIRMED', 'PENDING', 'CONFIRMED', 'f0000000-0000-4000-8000-000000000006', 'NHAN_VIEN_TIEP_NHAN', '11111111-1111-4111-8111-111111111111', '{"tableCode":"T01"}', @created + INTERVAL 30 MINUTE),
  ('72000000-0000-4000-8000-000000000003', 'CREATED', NULL, 'PENDING', 'public', 'KHACH_HANG', NULL, '{"partySize":6,"serviceType":"PRE_ORDER"}', @created),
  ('72000000-0000-4000-8000-000000000003', 'CONFIRMED', 'PENDING', 'CONFIRMED', 'f0000000-0000-4000-8000-000000000006', 'NHAN_VIEN_TIEP_NHAN', '11111111-1111-4111-8111-111111111111', '{"tableCode":"T04"}', @created + INTERVAL 40 MINUTE),
  ('72000000-0000-4000-8000-000000000004', 'CREATED', NULL, 'PENDING', 'public', 'KHACH_HANG', NULL, '{"partySize":2,"serviceType":"DINE_IN"}', @created),
  ('72000000-0000-4000-8000-000000000005', 'CREATED', NULL, 'PENDING', 'public', 'KHACH_HANG', NULL, '{"partySize":3,"serviceType":"DINE_IN"}', @created),
  ('72000000-0000-4000-8000-000000000006', 'CREATED', NULL, 'PENDING', 'public', 'KHACH_HANG', NULL, '{"partySize":4,"serviceType":"DINE_IN"}', @created),
  ('72000000-0000-4000-8000-000000000006', 'CANCELLED', 'PENDING', 'CANCELLED', 'f0000000-0000-4000-8000-000000000006', 'NHAN_VIEN_TIEP_NHAN', '11111111-1111-4111-8111-111111111111', '{"reason":"Khách gọi điện báo đổi lịch sang tuần sau"}', @created + INTERVAL 50 MINUTE);

INSERT INTO notifications (id, reservation_id, branch_id, channel, recipient, event, content, status, attempts, created_at, processed_at) VALUES
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'STAFF', 'branch:11111111-1111-4111-8111-111111111111', 'CREATED', 'Đơn đặt bàn mới DB-DEMO-0001: 4 khách lúc 18:00 ngày mai, đang chờ xác nhận.', 'SIMULATED', 1, @created, @created),
  ('73000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'SMS', '0912345678', 'CONFIRMED', 'Nhà hàng Nhóm 6: đơn đặt bàn DB-DEMO-0002 đã được xác nhận. Bàn 1, 19:00 ngày mai, 2 khách. Hẹn gặp quý khách!', 'SIMULATED', 1, @created + INTERVAL 30 MINUTE, @created + INTERVAL 30 MINUTE),
  ('73000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', 'SMS', '0889001122', 'CANCELLED', 'Đơn đặt bàn của quý khách đã bị hủy: DB-DEMO-0006. Lý do: Khách gọi điện báo đổi lịch sang tuần sau', 'SIMULATED', 1, @created + INTERVAL 50 MINUTE, @created + INTERVAL 50 MINUTE);

COMMIT;
