-- Rewrite-only durable preparation, handback uncertainty, attestation and resolution.
CREATE TABLE pos_rewrite_cash_return_intents (
 id CHAR(36) COLLATE ascii_bin PRIMARY KEY,order_id VARCHAR(32) COLLATE ascii_bin NOT NULL,
 store_id VARCHAR(32) COLLATE ascii_bin NOT NULL,counter_id VARCHAR(32) COLLATE ascii_bin NOT NULL,
 prepared_by VARCHAR(32) COLLATE ascii_bin NOT NULL,original_payment_id CHAR(36) COLLATE ascii_bin NOT NULL,
 active_payment_id CHAR(36) COLLATE ascii_bin NULL,correction_id CHAR(36) COLLATE ascii_bin NOT NULL,
 cash_return_receipt_id CHAR(36) COLLATE ascii_bin NOT NULL,phase VARCHAR(20) COLLATE ascii_bin NOT NULL,
 body JSON NOT NULL,body_hash CHAR(64) COLLATE ascii_bin NOT NULL,impact_from DATE NOT NULL,
 created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,
 UNIQUE KEY cash_return_active_payment(active_payment_id),UNIQUE KEY cash_return_correction(correction_id),
 UNIQUE KEY cash_return_receipt(cash_return_receipt_id),
 KEY cash_return_pending_scope(store_id,phase,id),KEY cash_return_order(order_id,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_cash_return_commands (
 id CHAR(36) COLLATE ascii_bin PRIMARY KEY,intent_id CHAR(36) COLLATE ascii_bin NOT NULL,
 kind VARCHAR(16) COLLATE ascii_bin NOT NULL,actor_id VARCHAR(32) COLLATE ascii_bin NOT NULL,
 session_hash CHAR(64) COLLATE ascii_bin NOT NULL,request_hash CHAR(64) COLLATE ascii_bin NOT NULL,
 body JSON NOT NULL,body_hash CHAR(64) COLLATE ascii_bin NOT NULL,request_id VARCHAR(128) COLLATE ascii_bin NULL,proof_hash CHAR(64) COLLATE ascii_bin NOT NULL,
 recorded_at DATETIME(3) NOT NULL,KEY cash_return_command_intent(intent_id,recorded_at,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_cash_return_controls (
 store_id VARCHAR(32) COLLATE ascii_bin PRIMARY KEY,revision BIGINT UNSIGNED NOT NULL,
 manifest_hash CHAR(64) COLLATE ascii_bin NOT NULL,unresolved_count INT UNSIGNED NOT NULL,pending_from DATE NULL,partition_count INT UNSIGNED NOT NULL,partition_manifest_hash CHAR(64) COLLATE ascii_bin NOT NULL,
 proof_hash CHAR(64) COLLATE ascii_bin NOT NULL,updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_cash_return_partition_controls (
 id VARCHAR(48) COLLATE ascii_bin PRIMARY KEY,store_id VARCHAR(32) COLLATE ascii_bin NOT NULL,business_date DATE NOT NULL,
 revision BIGINT UNSIGNED NOT NULL,manifest_hash CHAR(64) COLLATE ascii_bin NOT NULL,financial_fact_count INT UNSIGNED NOT NULL,financial_fact_hash CHAR(64) COLLATE ascii_bin NOT NULL,proof_hash CHAR(64) COLLATE ascii_bin NOT NULL,
 updated_at DATETIME(3) NOT NULL,UNIQUE KEY cash_return_partition_scope(store_id,business_date)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_cash_return_claims (
 id CHAR(36) COLLATE ascii_bin PRIMARY KEY,store_id VARCHAR(32) COLLATE ascii_bin NOT NULL,order_id VARCHAR(32) COLLATE ascii_bin NOT NULL,
 counter_id VARCHAR(32) COLLATE ascii_bin NOT NULL,original_payment_id CHAR(36) COLLATE ascii_bin NOT NULL,cash_return_receipt_id CHAR(36) COLLATE ascii_bin NOT NULL,body JSON NOT NULL,body_hash CHAR(64) COLLATE ascii_bin NOT NULL,
 impact_from DATE NOT NULL,created_at DATETIME(3) NOT NULL,request_id VARCHAR(128) COLLATE ascii_bin NULL,
 UNIQUE KEY cash_return_claim_payment(original_payment_id),UNIQUE KEY cash_return_claim_receipt(cash_return_receipt_id),KEY cash_return_claim_store(store_id,id),KEY cash_return_claim_order(order_id,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_cash_return_claim_resolutions (
 id CHAR(36) COLLATE ascii_bin PRIMARY KEY,actor_id VARCHAR(32) COLLATE ascii_bin NOT NULL,session_hash CHAR(64) COLLATE ascii_bin NOT NULL,
 receipt_hash CHAR(64) COLLATE ascii_bin NOT NULL,proof_hash CHAR(64) COLLATE ascii_bin NOT NULL,recorded_at DATETIME(3) NOT NULL,
 request_id VARCHAR(128) COLLATE ascii_bin NULL
) ENGINE=InnoDB;
