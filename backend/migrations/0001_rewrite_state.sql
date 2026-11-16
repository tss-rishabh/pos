-- Apply explicitly to the writer after review. Never apply to the supplied reader.
CREATE TABLE pos_rewrite_drafts (
  operator_id VARCHAR(32) NOT NULL,
  id VARCHAR(36) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  counter_id VARCHAR(32) NOT NULL,
  version INT NOT NULL,
  payload JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (operator_id,id),
  INDEX ix_rewrite_draft_store_counter (store_id,counter_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_mutations (
  operator_id VARCHAR(32) NOT NULL,
  id VARCHAR(36) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  result JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (operator_id,id)
) ENGINE=InnoDB;
