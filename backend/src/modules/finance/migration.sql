CREATE TABLE pos_rewrite_finance_commands (
  operator_id VARCHAR(32) NOT NULL,command_id CHAR(36) NOT NULL,
  request_hash CHAR(64) NOT NULL,close_id VARCHAR(32) NULL,created_at DATETIME NOT NULL,
  PRIMARY KEY(operator_id,command_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_finance_alert_commands (
  command_id CHAR(36) PRIMARY KEY,request_hash CHAR(64) NOT NULL,result JSON NULL,created_at DATETIME NOT NULL
) ENGINE=InnoDB;
