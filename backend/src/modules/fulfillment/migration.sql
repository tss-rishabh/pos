-- New rewrite-owned state only. Apply explicitly to the writer after review.
CREATE TABLE pos_rewrite_fulfillment_commands (
  operator_id VARCHAR(32) NOT NULL, command_id CHAR(36) NOT NULL,
  request_hash CHAR(64) NOT NULL, result JSON NULL, created_at DATETIME NOT NULL,
  PRIMARY KEY(operator_id,command_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_notification_events (
  event_id CHAR(36) NOT NULL,store_id VARCHAR(32) NOT NULL,request_hash CHAR(64) NOT NULL,request_id CHAR(36) NULL,
  notice JSON NULL,created_at DATETIME NOT NULL,published_at DATETIME NULL,
  PRIMARY KEY(event_id,store_id),INDEX ix_notification_event_pending(published_at,created_at)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_fulfillment_effects (
  id CHAR(36) PRIMARY KEY,dispatch_order BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE, command_id CHAR(36) NOT NULL, operator_id VARCHAR(32) NOT NULL,request_id CHAR(36) NULL,
  store_id VARCHAR(32) NOT NULL, order_id VARCHAR(32) NOT NULL, kind VARCHAR(40) NOT NULL,
  payload JSON NOT NULL, status VARCHAR(16) NOT NULL, attempts INT NOT NULL,sequence INT NOT NULL,result JSON NULL,
  claimed_at DATETIME NULL, completed_at DATETIME NULL, last_error_code VARCHAR(64) NULL,
  created_at DATETIME NOT NULL,
  INDEX ix_fulfillment_effect_pending(status,created_at),
  INDEX ix_fulfillment_effect_command(operator_id,command_id)
  ,INDEX ix_fulfillment_counter_order(store_id,kind,dispatch_order,status)
) ENGINE=InnoDB;
