-- Rewrite-owned timing/settings effects only. Apply after administration/media migrations.
INSERT IGNORE INTO pos_rewrite_administration_registries(resource) VALUES ('settings');
CREATE TABLE IF NOT EXISTS pos_rewrite_settings_effects (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id VARCHAR(36) NOT NULL,
  partition_key VARCHAR(96) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  payload JSON NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  delivered_at DATETIME(3) NULL,
  UNIQUE KEY uq_rewrite_settings_effect_id(id),
  INDEX ix_rewrite_settings_effect_dispatch(delivered_at,attempts,sequence),
  INDEX ix_rewrite_settings_effect_partition(partition_key,delivered_at,sequence),
  INDEX ix_rewrite_settings_effect_blocked(delivered_at,sequence,attempts)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_settings_mutations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  actor_id VARCHAR(32) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_ecommerce_changes (
  store_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  locked_until DATETIME(3) NOT NULL
) ENGINE=InnoDB;
