ALTER TABLE payments ADD COLUMN client_ip VARCHAR(45) NOT NULL DEFAULT '127.0.0.1';
ALTER TABLE payment_outbox ADD COLUMN worker_group VARCHAR(64) NOT NULL DEFAULT 'default';
CREATE INDEX payment_outbox_worker ON payment_outbox(worker_group,state,next_at);
