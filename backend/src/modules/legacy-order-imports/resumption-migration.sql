CREATE TABLE pos_rewrite_legacy_order_import_resumptions (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  job_id VARCHAR(36) NOT NULL,
  actor_id VARCHAR(32) NOT NULL,
  job_request_hash VARCHAR(64) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  claim_token VARCHAR(36) NOT NULL,
  proof_hash VARCHAR(64) NOT NULL,
  accepted_at DATETIME(3) NOT NULL,
  KEY ix_legacy_order_import_resumption_job (job_id,accepted_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
