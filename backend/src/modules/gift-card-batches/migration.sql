-- Rewrite-owned work/receipts only. No legacy gift/financial DDL is executed.
CREATE TABLE IF NOT EXISTS pos_rewrite_gift_card_batch_jobs (
 id VARCHAR(36) NOT NULL PRIMARY KEY,batch_id VARCHAR(32) NOT NULL,actor_id VARCHAR(32) NOT NULL,actor_version VARCHAR(64) NOT NULL,requested_size INT NOT NULL,
 sealed_secrets TEXT NOT NULL,phase VARCHAR(24) NOT NULL,artifact_bytes MEDIUMBLOB NULL,artifact_key VARCHAR(255) NOT NULL,artifact_checksum VARCHAR(64) NULL,artifact_size INT NULL,
 attempts INT NOT NULL,error_code VARCHAR(64) NULL,lease_token VARCHAR(36) NULL,lease_expires_at DATETIME(3) NULL,delivery_attempt_id VARCHAR(36) NULL,
 request_id VARCHAR(128) NULL,created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,
 UNIQUE KEY uq_gift_card_batch_job_batch(batch_id),INDEX ix_gift_card_batch_job_pending(phase,lease_expires_at,created_at),INDEX ix_gift_card_batch_job_actor(actor_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_gift_card_batch_mutations (
 id VARCHAR(36) NOT NULL PRIMARY KEY,actor_id VARCHAR(32) NOT NULL,batch_id VARCHAR(32) NOT NULL,action VARCHAR(24) NOT NULL,input_hash VARCHAR(64) NOT NULL,result JSON NOT NULL,
 request_id VARCHAR(128) NULL,created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
INSERT IGNORE INTO pos_rewrite_administration_registries(resource) VALUES ('gift-card-batches');
