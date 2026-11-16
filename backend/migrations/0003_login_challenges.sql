-- Staff password proof is bound to a short-lived challenge. OTP plaintext is never stored.
CREATE TABLE pos_rewrite_login_challenges (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL,
  proof_hash VARCHAR(64) NOT NULL,
  auth_version VARCHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  sent_count INT NOT NULL DEFAULT 0,
  INDEX ix_login_challenge_user(user_id),
  INDEX ix_login_challenge_expiry(expires_at)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_login_security (
  user_id VARCHAR(32) PRIMARY KEY,
  otp_hash VARCHAR(64) NULL,
  otp_expires_at DATETIME(3) NULL,
  last_attempt_at DATETIME(3) NULL,
  failed_count INT NOT NULL DEFAULT 0,
  failure_window_until DATETIME(3) NULL,
  locked_until DATETIME(3) NULL,
  last_sent_at DATETIME(3) NULL,
  alert_pending BOOLEAN NOT NULL DEFAULT FALSE
) ENGINE=InnoDB;
