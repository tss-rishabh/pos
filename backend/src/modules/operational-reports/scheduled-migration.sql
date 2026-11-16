-- Rewrite-owned scheduled-report and destination ledger. No legacy tables are created or altered.
CREATE TABLE IF NOT EXISTS pos_rewrite_scheduled_reports (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  command_id VARCHAR(36) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  request_id VARCHAR(128) NULL,
  user_id VARCHAR(32) NOT NULL,
  input JSON NOT NULL,
  status VARCHAR(24) NOT NULL,
  record_count INT NULL,
  error_code VARCHAR(64) NULL,
  claim_token VARCHAR(36) NULL,
  lease_until DATETIME(3) NULL,
  requested_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  UNIQUE KEY uq_scheduled_report_command(command_id),
  KEY ix_scheduled_report_queue(status,lease_until,requested_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_scheduled_report_channels (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  next_allowed_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_scheduled_report_targets (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  job_id VARCHAR(36) NOT NULL,
  target VARCHAR(8) NOT NULL,
  part INT NOT NULL,
  body MEDIUMTEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  claim_token VARCHAR(36) NULL,
  lease_until DATETIME(3) NULL,
  attempted_at DATETIME(3) NULL,
  delivered_at DATETIME(3) NULL,
  reconciliation_command_id VARCHAR(36) NULL,
  reconciliation_outcome VARCHAR(16) NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_scheduled_report_target(job_id,target,part),
  KEY ix_scheduled_report_target_queue(status,lease_until),
  KEY ix_scheduled_report_target_job(job_id)
) ENGINE=InnoDB;
