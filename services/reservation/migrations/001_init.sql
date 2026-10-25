-- reservation_db schema v1. branch_id / account ids are ID references only (no cross-schema FK).
-- All DATETIME columns hold UTC; the web converts to Asia/Ho_Chi_Minh for display.

CREATE TABLE IF NOT EXISTS tables (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  branch_id VARCHAR(36) NOT NULL,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  capacity SMALLINT NOT NULL,
  location VARCHAR(100) NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tables_branch_code (branch_id, code),
  KEY ix_tables_branch (branch_id, status, capacity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A phone number is contact data, not a login identity. Rows are reused only for an identical (phone, name).
CREATE TABLE IF NOT EXISTS customers (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_customers_phone (phone, full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reservations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  customer_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36) NOT NULL,
  table_id VARCHAR(36) NULL,
  starts_at DATETIME(3) NOT NULL,
  ends_at DATETIME(3) NOT NULL,
  party_size SMALLINT NOT NULL,
  service_type ENUM('DINE_IN','PRE_ORDER') NOT NULL,
  status ENUM('PENDING','CONFIRMED','CANCEL_PENDING','CANCELLED') NOT NULL DEFAULT 'PENDING',
  cancel_reason VARCHAR(500) NULL,
  confirmed_by VARCHAR(64) NULL,
  confirmed_at DATETIME(3) NULL,
  cancelled_by VARCHAR(64) NULL,
  cancel_requested_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  version INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_res_code (code),
  KEY ix_res_branch (branch_id, status, starts_at),
  KEY ix_res_table (table_id, status, starts_at),
  CONSTRAINT fk_res_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_res_table FOREIGN KEY (table_id) REFERENCES tables(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outbox: every message to a customer (SMS) or to the branch's reception (STAFF) is written in the same
-- transaction as the change. A worker hands PENDING rows to the adapter; v1 uses a simulator.
CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  reservation_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36) NOT NULL,
  channel ENUM('SMS','STAFF') NOT NULL,
  recipient VARCHAR(64) NOT NULL,
  event ENUM('CREATED','CONFIRMED','UPDATED','CANCELLED') NOT NULL,
  content VARCHAR(500) NOT NULL,
  status ENUM('PENDING','SIMULATED','SENT','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  last_error VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  KEY ix_notif_status (status, created_at),
  KEY ix_notif_branch (branch_id, created_at),
  CONSTRAINT fk_notif_reservation FOREIGN KEY (reservation_id) REFERENCES reservations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope VARCHAR(160) NOT NULL,
  idem_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status_code SMALLINT NULL,
  response_body JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (scope, idem_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
