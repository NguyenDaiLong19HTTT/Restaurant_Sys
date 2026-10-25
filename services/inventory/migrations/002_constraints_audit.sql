-- Database-level guarantees: even a buggy query or manual SQL cannot put data in an invalid state.
-- CHECK = shape of a row; TRIGGER = allowed state transitions and immutability; audit_logs = who did what.

-- ---------- CHECK constraints ----------
ALTER TABLE ingredients
  ADD CONSTRAINT ck_ing_code_format CHECK (code REGEXP '^[A-Z0-9-]{2,32}$'),
  ADD CONSTRAINT ck_ing_name_not_blank CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  ADD CONSTRAINT ck_ing_unit_not_blank CHECK (CHAR_LENGTH(TRIM(unit)) > 0);

ALTER TABLE warehouses
  ADD CONSTRAINT ck_wh_name_not_blank CHECK (CHAR_LENGTH(TRIM(name)) > 0);

ALTER TABLE transfer_requests
  ADD CONSTRAINT ck_tr_reason_not_blank CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  ADD CONSTRAINT ck_tr_version_positive CHECK (version >= 1),
  ADD CONSTRAINT ck_tr_supplier_differs CHECK (supplier_branch_id IS NULL OR supplier_branch_id <> requester_branch_id),
  -- Once approved (and afterwards) the supplier branch, warehouse and approver must be recorded.
  ADD CONSTRAINT ck_tr_approved_fields CHECK (
    status IN ('PENDING_APPROVAL', 'REJECTED')
    OR (supplier_branch_id IS NOT NULL AND supplier_warehouse_id IS NOT NULL
        AND approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  ADD CONSTRAINT ck_tr_rejected_fields CHECK (
    status <> 'REJECTED'
    OR (rejection_reason IS NOT NULL AND CHAR_LENGTH(TRIM(rejection_reason)) > 0
        AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL)),
  ADD CONSTRAINT ck_tr_pending_clean CHECK (
    status <> 'PENDING_APPROVAL' OR (supplier_branch_id IS NULL AND approved_by IS NULL AND rejected_by IS NULL));

ALTER TABLE export_slips
  ADD CONSTRAINT ck_es_version_positive CHECK (version >= 1),
  ADD CONSTRAINT ck_es_confirmed_fields CHECK (
    status = 'PENDING' OR (confirmed_by IS NOT NULL AND exported_at IS NOT NULL));

ALTER TABLE import_slips
  ADD CONSTRAINT ck_is_version_positive CHECK (version >= 1),
  ADD CONSTRAINT ck_is_confirmed_fields CHECK (
    status = 'PENDING' OR (confirmed_by IS NOT NULL AND imported_at IS NOT NULL AND warehouse_id IS NOT NULL));

ALTER TABLE stock_movements
  ADD CONSTRAINT ck_sm_delta_not_zero CHECK (quantity_delta <> 0),
  ADD CONSTRAINT ck_sm_balance_non_negative CHECK (balance_after >= 0);

-- ---------- Audit log (append-only) ----------
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transfer_request_id VARCHAR(36) NOT NULL,
  entity_type ENUM('TRANSFER_REQUEST', 'EXPORT_SLIP', 'IMPORT_SLIP') NOT NULL,
  entity_id VARCHAR(36) NOT NULL,
  action ENUM('CREATED', 'UPDATED', 'DELETED', 'APPROVED', 'REJECTED', 'EXPORT_CONFIRMED', 'IMPORT_CONFIRMED') NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NULL,
  actor_account_id VARCHAR(64) NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  actor_branch_id VARCHAR(36) NULL,
  request_id VARCHAR(128) NULL,
  details JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_transfer (transfer_request_id, created_at),
  KEY ix_audit_actor (actor_account_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- Triggers: state machine & immutability ----------
CREATE TRIGGER trg_tr_before_update BEFORE UPDATE ON transfer_requests FOR EACH ROW
BEGIN
  IF NEW.code <> OLD.code OR NEW.requester_branch_id <> OLD.requester_branch_id OR NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IMMUTABLE_FIELD';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'EXPORTED')
    OR (OLD.status = 'EXPORTED' AND NEW.status = 'IMPORTED')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INVALID_STATUS_TRANSITION';
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' AND NOT (NEW.reason <=> OLD.reason) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'REQUEST_LOCKED';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'VERSION_NOT_INCREMENTED';
  END IF;
END;

CREATE TRIGGER trg_tr_before_delete BEFORE DELETE ON transfer_requests FOR EACH ROW
BEGIN
  IF OLD.status <> 'PENDING_APPROVAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'REQUEST_LOCKED';
  END IF;
END;

-- Item lines may only change while the parent request is still waiting for approval.
CREATE TRIGGER trg_ti_before_insert BEFORE INSERT ON transfer_items FOR EACH ROW
BEGIN
  IF (SELECT status FROM transfer_requests WHERE id = NEW.request_id) <> 'PENDING_APPROVAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'REQUEST_LOCKED';
  END IF;
END;

CREATE TRIGGER trg_ti_before_update BEFORE UPDATE ON transfer_items FOR EACH ROW
BEGIN
  IF (SELECT status FROM transfer_requests WHERE id = OLD.request_id) <> 'PENDING_APPROVAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'REQUEST_LOCKED';
  END IF;
END;

CREATE TRIGGER trg_ti_before_delete BEFORE DELETE ON transfer_items FOR EACH ROW
BEGIN
  IF (SELECT status FROM transfer_requests WHERE id = OLD.request_id) <> 'PENDING_APPROVAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'REQUEST_LOCKED';
  END IF;
END;

-- Slips: PENDING -> CONFIRMED only, and nothing changes after confirmation.
CREATE TRIGGER trg_es_before_update BEFORE UPDATE ON export_slips FOR EACH ROW
BEGIN
  IF OLD.status = 'CONFIRMED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SLIP_LOCKED';
  END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.branch_id <> OLD.branch_id OR NEW.warehouse_id <> OLD.warehouse_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IMMUTABLE_FIELD';
  END IF;
END;

CREATE TRIGGER trg_es_before_delete BEFORE DELETE ON export_slips FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SLIP_LOCKED';
END;

CREATE TRIGGER trg_is_before_update BEFORE UPDATE ON import_slips FOR EACH ROW
BEGIN
  IF OLD.status = 'CONFIRMED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SLIP_LOCKED';
  END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.branch_id <> OLD.branch_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'IMMUTABLE_FIELD';
  END IF;
END;

CREATE TRIGGER trg_is_before_delete BEFORE DELETE ON import_slips FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SLIP_LOCKED';
END;

-- Ledger tables are append-only.
CREATE TRIGGER trg_sm_before_update BEFORE UPDATE ON stock_movements FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'APPEND_ONLY';
END;

CREATE TRIGGER trg_sm_before_delete BEFORE DELETE ON stock_movements FOR EACH ROW
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
