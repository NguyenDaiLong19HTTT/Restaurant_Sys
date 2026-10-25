CREATE TABLE IF NOT EXISTS demo_tables (
 id VARCHAR(64) PRIMARY KEY, branch_id VARCHAR(64) NOT NULL, name VARCHAR(80) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', occupancy VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE', version INT NOT NULL DEFAULT 1
);
ALTER TABLE demo_orders ADD COLUMN table_id VARCHAR(64) NULL;
CREATE INDEX demo_order_table_branch ON demo_orders(table_id,branch_id,payment_status);
ALTER TABLE payments ADD COLUMN stale_reason VARCHAR(80) NULL;
