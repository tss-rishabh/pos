-- Rewrite-owned tables only. Apply explicitly to the writer; never to a reader.
CREATE TABLE IF NOT EXISTS pos_rewrite_administration_registries (
  resource VARCHAR(32) NOT NULL PRIMARY KEY
) ENGINE=InnoDB;
INSERT IGNORE INTO pos_rewrite_administration_registries(resource)
VALUES ('stores'),('operators'),('salespeople');

CREATE TABLE IF NOT EXISTS pos_rewrite_operator_checkins (
  operator_id VARCHAR(32) NOT NULL PRIMARY KEY,
  store_id BIGINT UNSIGNED NOT NULL,
  counter_id BIGINT UNSIGNED NULL,
  expires_at DATETIME(3) NOT NULL,
  checked_in_at DATETIME(3) NOT NULL,
  INDEX ix_rewrite_checkin_expiry(expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pos_rewrite_administration_outbox (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  kind VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  delivered_at DATETIME(3) NULL,
  INDEX ix_rewrite_administration_outbox_delivery(delivered_at,attempts,created_at),
  INDEX ix_rewrite_administration_outbox_exhausted(delivered_at,id,attempts)
) ENGINE=InnoDB;
