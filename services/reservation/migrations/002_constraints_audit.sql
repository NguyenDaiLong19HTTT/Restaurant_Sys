-- Database-level guarantees: even a buggy query or manual SQL cannot put data in an invalid state.
-- CHECK = shape of a row; TRIGGER = state machine, immutability, table/time conflicts; audit_logs = who did what.

-- ---------- CHECK constraints ----------
ALTER TABLE tables
  ADD CONSTRAINT ck_tbl_code_format CHECK (code REGEXP '^[A-Z0-9-]{1,20}$'),
  ADD CONSTRAINT ck_tbl_name_not_blank CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  ADD CONSTRAINT ck_tbl_capacity CHECK (capacity BETWEEN 1 AND 50);

ALTER TABLE customers
  ADD CONSTRAINT ck_cus_name_not_blank CHECK (CHAR_LENGTH(TRIM(full_name)) >= 2),
  -- Stored normalised: 10 digits starting with 0 (API converts +84 / 84 prefixes).
  ADD CONSTRAINT ck_cus_phone_format CHECK (phone REGEXP '^0[35789][0-9]{8}$');

ALTER TABLE reservations
  ADD CONSTRAINT ck_res_party_size CHECK (party_size BETWEEN 1 AND 50),
  ADD CONSTRAINT ck_res_time_range CHECK (ends_at > starts_at),
  ADD CONSTRAINT ck_res_version_positive CHECK (version >= 1),
  -- BR006: a new booking has no table; a table is assigned only when reception confirms it.
  ADD CONSTRAINT ck_res_pending_no_table CHECK (status <> 'PENDING' OR (table_id IS NULL AND confirmed_by IS NULL)),
  ADD CONSTRAINT ck_res_confirmed_fields CHECK (
    status NOT IN ('CONFIRMED', 'CANCEL_PENDING')
    OR (table_id IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  -- BR026/BR027: a cancellation always records its reason, who asked and when.
  ADD CONSTRAINT ck_res_cancel_fields CHECK (
    status NOT IN ('CANCEL_PENDING', 'CANCELLED')
    OR (cancel_reason IS NOT NULL AND CHAR_LENGTH(TRIM(cancel_reason)) > 0
        AND cancelled_by IS NOT NULL AND cancel_requested_at IS NOT NULL)),
  ADD CONSTRAINT ck_res_cancelled_at CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL);

-- ---------- Audit log (append-only) ----------
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reservation_id VARCHAR(36) NOT NULL,
  action ENUM('CREATED', 'CONFIRMED', 'UPDATED', 'CANCEL_REQUESTED', 'CANCELLED') NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NULL,
  actor_account_id VARCHAR(64) NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  actor_branch_id VARCHAR(36) NULL,
  request_id VARCHAR(128) NULL,
  details JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_reservation (reservation_id, created_at),
  KEY ix_audit_actor (actor_account_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Triggers ----------
CREATE TRIGGER trg_res_before_insert BEFORE INSERT ON reservations FOR EACH ROW
BEGIN
  IF NEW.status <> 'PENDING' OR NEW.table_id IS NOT NULL OR NEW.version <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INVALID_INITIAL_STATE';
  END IF;
END;

CREATE TRIGGER trg_res_before_update BEFORE UPDATE ON reservations FOR EACH ROW
BEGIN
  DECLARE tbl_branch VARCHAR(36);
  DECLARE tbl_capacity SMALLINT;
  DECLARE tbl_status VARCHAR(10);

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

-- Bookings are cancelled, never deleted, so history and notifications stay traceable.
CREATE TRIGGER trg_res_before_delete BEFORE DELETE ON reservations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RESERVATION_LOCKED';
END;

-- Outbox rows: only delivery fields change; the message itself is fixed once written.
CREATE TRIGGER trg_notif_before_update BEFORE UPDATE ON notifications FOR EACH ROW
BEGIN
  IF NEW.reservation_id <> OLD.reservation_id OR NEW.channel <> OLD.channel OR NEW.recipient <> OLD.recipient
     OR NEW.event <> OLD.event OR NEW.content <> OLD.content OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IMMUTABLE_FIELD';
  END IF;
END;

CREATE TRIGGER trg_notif_before_delete BEFORE DELETE ON notifications FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'APPEND_ONLY';
END;

CREATE TRIGGER trg_audit_before_update BEFORE UPDATE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'APPEND_ONLY';
END;

CREATE TRIGGER trg_audit_before_delete BEFORE DELETE ON audit_logs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'APPEND_ONLY';
END;
