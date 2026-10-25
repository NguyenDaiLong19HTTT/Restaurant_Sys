-- inventory_db schema v1. branch_id / created_by are ID references only (no cross-schema FK).

CREATE TABLE IF NOT EXISTS ingredients (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(150) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  description VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ingredients_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouses (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  branch_id VARCHAR(36) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(150) NOT NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_warehouses_code (code),
  KEY ix_warehouses_branch (branch_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_balances (
  warehouse_id VARCHAR(36) NOT NULL,
  ingredient_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (warehouse_id, ingredient_id),
  CONSTRAINT fk_sb_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_sb_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients(id),
  CONSTRAINT ck_sb_non_negative CHECK (quantity >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transfer_requests (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  requester_branch_id VARCHAR(36) NOT NULL,
  supplier_branch_id VARCHAR(36) NULL,
  supplier_warehouse_id VARCHAR(36) NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('PENDING_APPROVAL','APPROVED','EXPORTED','IMPORTED','REJECTED') NOT NULL DEFAULT 'PENDING_APPROVAL',
  rejection_reason VARCHAR(500) NULL,
  version INT NOT NULL DEFAULT 1,
  created_by VARCHAR(64) NOT NULL,
  approved_by VARCHAR(64) NULL,
  approved_at DATETIME(3) NULL,
  rejected_by VARCHAR(64) NULL,
  rejected_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tr_code (code),
  KEY ix_tr_requester (requester_branch_id, status),
  KEY ix_tr_supplier (supplier_branch_id, status),
  CONSTRAINT fk_tr_supplier_wh FOREIGN KEY (supplier_warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transfer_items (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  request_id VARCHAR(36) NOT NULL,
  ingredient_id VARCHAR(36) NOT NULL,
  quantity DECIMAL(14,3) NOT NULL,
  note VARCHAR(255) NULL,
  UNIQUE KEY uq_ti_request_ingredient (request_id, ingredient_id),
  CONSTRAINT fk_ti_request FOREIGN KEY (request_id) REFERENCES transfer_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_ti_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients(id),
  CONSTRAINT ck_ti_positive CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS export_slips (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  request_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36) NOT NULL,
  warehouse_id VARCHAR(36) NOT NULL,
  status ENUM('PENDING','CONFIRMED') NOT NULL DEFAULT 'PENDING',
  version INT NOT NULL DEFAULT 1,
  confirmed_by VARCHAR(64) NULL,
  exported_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_es_code (code),
  UNIQUE KEY uq_es_request (request_id),
  KEY ix_es_branch (branch_id, status),
  CONSTRAINT fk_es_request FOREIGN KEY (request_id) REFERENCES transfer_requests(id),
  CONSTRAINT fk_es_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS import_slips (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  request_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36) NOT NULL,
  warehouse_id VARCHAR(36) NULL,
  status ENUM('PENDING','CONFIRMED') NOT NULL DEFAULT 'PENDING',
  version INT NOT NULL DEFAULT 1,
  confirmed_by VARCHAR(64) NULL,
  imported_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_is_code (code),
  UNIQUE KEY uq_is_request (request_id),
  KEY ix_is_branch (branch_id, status),
  CONSTRAINT fk_is_request FOREIGN KEY (request_id) REFERENCES transfer_requests(id),
  CONSTRAINT fk_is_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (source document, ingredient): the UNIQUE key is the last line of defence
-- against deducting/adding stock twice for the same slip.
CREATE TABLE IF NOT EXISTS stock_movements (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  warehouse_id VARCHAR(36) NOT NULL,
  ingredient_id VARCHAR(36) NOT NULL,
  quantity_delta DECIMAL(14,3) NOT NULL,
  balance_after DECIMAL(14,3) NOT NULL,
  source_type ENUM('SEED','EXPORT_SLIP','IMPORT_SLIP','ADJUSTMENT') NOT NULL,
  source_id VARCHAR(36) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sm_source (source_type, source_id, ingredient_id),
  KEY ix_sm_warehouse (warehouse_id, created_at),
  CONSTRAINT fk_sm_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_sm_ingredient FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
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
