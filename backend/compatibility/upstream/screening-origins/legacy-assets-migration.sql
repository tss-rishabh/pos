CREATE TABLE pos_rewrite_screening_origin_legacy_cash_assets(
 command_id VARCHAR(36) NOT NULL PRIMARY KEY,order_id BIGINT NOT NULL UNIQUE,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
