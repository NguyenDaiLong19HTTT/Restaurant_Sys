

CREATE TABLE IF NOT EXISTS shifts (
  id CHAR(36) PRIMARY KEY,
  branch_id CHAR(36) NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  registration_deadline DATETIME NOT NULL,
  required_count INT NOT NULL,
  CHECK (required_count > 0),
  CHECK (ends_at > starts_at),
  INDEX (branch_id)
);
CREATE TABLE IF NOT EXISTS shift_positions (
  shift_id CHAR(36) NOT NULL,
  position_id CHAR(36) NOT NULL,
  required_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (shift_id, position_id),
  FOREIGN KEY (shift_id) REFERENCES shifts(id),
  CHECK (required_count >= 0)
);
CREATE TABLE IF NOT EXISTS registrations (
  id CHAR(36) PRIMARY KEY,
  shift_id CHAR(36) NOT NULL,
  employee_id CHAR(36) NOT NULL,
  position_id CHAR(36) NULL,
  source ENUM('EMPLOYEE','MANAGER') NOT NULL DEFAULT 'EMPLOYEE',
  status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  reviewed_by CHAR(36) NULL,
  rejection_reason VARCHAR(500) NULL,
  UNIQUE (shift_id, employee_id),
  FOREIGN KEY (shift_id) REFERENCES shifts(id),
  INDEX (employee_id, status)
);
CREATE TABLE IF NOT EXISTS attendance (
  id CHAR(36) PRIMARY KEY,
  employee_id CHAR(36) NOT NULL,
  shift_id CHAR(36) NOT NULL,
  status ENUM('OPEN','COMPLETE') NOT NULL DEFAULT 'OPEN',
  INDEX (employee_id, status)
);
CREATE TABLE IF NOT EXISTS staff_requests (
  id CHAR(36) PRIMARY KEY,
  shift_id CHAR(36) NOT NULL,
  branch_id CHAR(36) NOT NULL,
  position_id CHAR(36) NOT NULL,
  quantity INT NOT NULL,
  note TEXT NULL,
  status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  requested_by CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (quantity > 0),
  FOREIGN KEY (shift_id) REFERENCES shifts(id),
  INDEX (branch_id)
);