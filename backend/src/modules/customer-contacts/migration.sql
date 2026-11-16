-- Rewrite-owned contact proofs, delivery, operation receipts and shared contact-key fencing only.
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_mutexes (contact_key VARCHAR(70) NOT NULL PRIMARY KEY) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_challenges (
 id VARCHAR(36) NOT NULL PRIMARY KEY,checkout_id VARCHAR(36) NOT NULL,operator_id VARCHAR(32) NOT NULL,store_id VARCHAR(32) NOT NULL,counter_id VARCHAR(32) NOT NULL,customer_id VARCHAR(32) NOT NULL,
 active_customer_id VARCHAR(32) NULL,actor_version VARCHAR(64) NOT NULL,contact_fingerprint VARCHAR(64) NOT NULL,request_hash VARCHAR(64) NOT NULL,kind VARCHAR(16) NOT NULL,target_key VARCHAR(70) NOT NULL,encrypted_input TEXT NOT NULL,
 status VARCHAR(24) NOT NULL,version INT NOT NULL,stage VARCHAR(8) NOT NULL,code_hash VARCHAR(64) NOT NULL,code_expires_at_ms BIGINT NOT NULL,attempts INT NOT NULL,current_verified_at_ms BIGINT NULL,new_verified_at_ms BIGINT NULL,expires_at_ms BIGINT NOT NULL,retry_at_ms BIGINT NOT NULL,
 request_id VARCHAR(128) NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_customer_contact_active_customer(active_customer_id),INDEX ix_customer_contact_checkout(checkout_id,created_at_ms),INDEX ix_customer_contact_expiry(status,expires_at_ms)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_reservations (contact_key VARCHAR(70) NOT NULL PRIMARY KEY,challenge_id VARCHAR(36) NOT NULL,expires_at_ms BIGINT NOT NULL,INDEX ix_customer_contact_reservation_owner(challenge_id)) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_limits (limit_key VARCHAR(96) NOT NULL PRIMARY KEY,budget_day VARCHAR(10) NOT NULL,sends INT NOT NULL,failures INT NOT NULL,last_sent_at_ms BIGINT NOT NULL) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_deliveries (
 id VARCHAR(36) NOT NULL PRIMARY KEY,challenge_id VARCHAR(36) NOT NULL,operator_id VARCHAR(32) NOT NULL,customer_id VARCHAR(32) NOT NULL,kind VARCHAR(24) NOT NULL,stage VARCHAR(8) NULL,encrypted_payload MEDIUMTEXT NOT NULL,
 status VARCHAR(16) NOT NULL,attempts INT NOT NULL,lease_token VARCHAR(36) NULL,lease_expires_at_ms BIGINT NULL,expires_at_ms BIGINT NOT NULL,request_id VARCHAR(128) NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,
 INDEX ix_customer_contact_delivery_pending(status,lease_expires_at_ms,created_at_ms),INDEX ix_customer_contact_delivery_owner(challenge_id,stage),INDEX ix_customer_contact_delivery_expiry(kind,expires_at_ms,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_mutations (id VARCHAR(36) NOT NULL PRIMARY KEY,challenge_id VARCHAR(36) NOT NULL,operator_id VARCHAR(32) NOT NULL,checkout_id VARCHAR(36) NOT NULL,action VARCHAR(24) NOT NULL,input_hash VARCHAR(64) NOT NULL,result JSON NOT NULL,created_at_ms BIGINT NOT NULL) ENGINE=InnoDB;
