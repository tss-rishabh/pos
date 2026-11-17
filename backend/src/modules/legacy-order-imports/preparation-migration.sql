-- Rewrite-owned native preparation control. No source table or financial effect.
CREATE TABLE IF NOT EXISTS pos_rewrite_import_financial_preparations (
 id VARCHAR(36) NOT NULL PRIMARY KEY,
 operation_id VARCHAR(36) NOT NULL,
 sequence_no INT UNSIGNED NOT NULL,
 data JSON NOT NULL,
 proof_hash VARCHAR(64) NOT NULL,
 artifact MEDIUMTEXT NULL,
 UNIQUE KEY uq_import_preparation_sequence(operation_id,sequence_no)
) ENGINE=InnoDB;
