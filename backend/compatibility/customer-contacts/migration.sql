-- Dedicated source-effect bridge state; no legacy account/financial DDL.
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_effect_receipts (
 id VARCHAR(36) NOT NULL PRIMARY KEY,body_hash VARCHAR(64) NOT NULL,operation_id VARCHAR(36) NOT NULL,challenge_id VARCHAR(36) NOT NULL,operator_id VARCHAR(32) NOT NULL,customer_id VARCHAR(32) NOT NULL,request_id VARCHAR(128) NULL,status VARCHAR(16) NOT NULL,sealed_payload MEDIUMTEXT NOT NULL,created_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_effect_jobs (
 id VARCHAR(36) NOT NULL PRIMARY KEY,receipt_id VARCHAR(36) NOT NULL,kind VARCHAR(24) NOT NULL,position INT NOT NULL,status VARCHAR(16) NOT NULL,sealed_payload MEDIUMTEXT NOT NULL,attempts INT NOT NULL,lease_token VARCHAR(36) NULL,lease_expires_at_ms BIGINT NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,
 INDEX ix_contact_effect_job_poll(status,lease_expires_at_ms,created_at_ms),INDEX ix_contact_effect_job_receipt(receipt_id,kind,status)
) ENGINE=InnoDB;
