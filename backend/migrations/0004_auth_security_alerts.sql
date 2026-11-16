-- Durable nonfinancial lockout notifications; all timestamps are rewrite-owned UTC.
CREATE TABLE pos_rewrite_login_security_alerts (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL,
  request_id VARCHAR(36) NULL,
  factor VARCHAR(8) NOT NULL,
  failed_attempts INT NOT NULL,
  locked_until DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  state VARCHAR(16) NOT NULL,
  attempts INT NOT NULL,
  available_at DATETIME(3) NOT NULL,
  lease_token VARCHAR(36) NULL,
  lease_until DATETIME(3) NULL,
  delivered_at DATETIME(3) NULL,
  INDEX ix_security_alert_ready(state,available_at),
  INDEX ix_security_alert_lease(state,lease_until),
  INDEX ix_security_alert_user(user_id,created_at)
) ENGINE=InnoDB;
