DROP TRIGGER IF EXISTS trg_res_before_insert;
CREATE TRIGGER trg_res_before_insert BEFORE INSERT ON reservations FOR EACH ROW
BEGIN
  IF NEW.status <> 'PENDING' OR NEW.table_id IS NOT NULL OR NEW.version <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INVALID_INITIAL_STATE';
  END IF;
END;
DROP TRIGGER IF EXISTS trg_res_before_update;
CREATE TRIGGER trg_res_before_update BEFORE UPDATE ON reservations FOR EACH ROW
BEGIN
  DECLARE tbl_branch VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  DECLARE tbl_capacity SMALLINT;
  DECLARE tbl_status VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  IF OLD.status = 'CANCELLED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RESERVATION_LOCKED';
  END IF;
  IF NEW.code <> OLD.code OR NEW.branch_id <> OLD.branch_id OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IMMUTABLE_FIELD';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('CONFIRMED', 'CANCELLED'))
    OR (OLD.status = 'CONFIRMED' AND NEW.status = 'CANCEL_PENDING')
    OR (OLD.status = 'CANCEL_PENDING' AND NEW.status = 'CANCELLED')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INVALID_STATUS_TRANSITION';
  END IF;
  -- While orders are being cancelled the booking itself is frozen.
  IF OLD.status = 'CANCEL_PENDING' AND (NOT (NEW.table_id <=> OLD.table_id) OR NEW.starts_at <> OLD.starts_at
      OR NEW.party_size <> OLD.party_size OR NEW.customer_id <> OLD.customer_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RESERVATION_LOCKED';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'VERSION_NOT_INCREMENTED';
  END IF;

  -- BR009/BR010: the table belongs to the same branch, seats the party and is free in [starts_at, ends_at).
  IF NEW.table_id IS NOT NULL AND NEW.status IN ('CONFIRMED', 'CANCEL_PENDING') AND (
       NOT (NEW.table_id <=> OLD.table_id) OR NEW.status <> OLD.status
       OR NEW.starts_at <> OLD.starts_at OR NEW.ends_at <> OLD.ends_at OR NEW.party_size <> OLD.party_size) THEN
    SELECT branch_id, capacity, status INTO tbl_branch, tbl_capacity, tbl_status FROM tables WHERE id = NEW.table_id;
    IF tbl_branch <> NEW.branch_id THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TABLE_BRANCH_MISMATCH';
    END IF;
    IF tbl_capacity < NEW.party_size OR tbl_status <> 'ACTIVE' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TABLE_NOT_SUITABLE';
    END IF;
    IF EXISTS (SELECT 1 FROM reservations r
                WHERE r.table_id = NEW.table_id AND r.id <> NEW.id
                  AND r.status IN ('CONFIRMED', 'CANCEL_PENDING')
                  AND r.starts_at < NEW.ends_at AND r.ends_at > NEW.starts_at) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TABLE_TIME_CONFLICT';
    END IF;
  END IF;
END;
DROP TRIGGER IF EXISTS trg_res_before_delete;
CREATE TRIGGER trg_res_before_delete BEFORE DELETE ON reservations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RESERVATION_LOCKED';
END;
DROP TRIGGER IF EXISTS trg_notif_before_update;
CREATE TRIGGER trg_notif_before_update BEFORE UPDATE ON notifications FOR EACH ROW
BEGIN
  IF NEW.reservation_id <> OLD.reservation_id OR NEW.channel <> OLD.channel OR NEW.recipient <> OLD.recipient
     OR NEW.event <> OLD.event OR NEW.content <> OLD.content OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IMMUTABLE_FIELD';
  END IF;
END;
DROP TRIGGER IF EXISTS trg_notif_before_delete;
CREATE TRIGGER trg_notif_before_delete BEFORE DELETE ON notifications FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'APPEND_ONLY';
END;
DROP TRIGGER IF EXISTS trg_audit_before_update;
CREATE TRIGGER trg_audit_before_update BEFORE UPDATE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'APPEND_ONLY';
END;
DROP TRIGGER IF EXISTS trg_audit_before_delete;
CREATE TRIGGER trg_audit_before_delete BEFORE DELETE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'APPEND_ONLY';
END;
