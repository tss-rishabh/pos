-- Rewrite-owned Django administration grants. Do not create/alter legacy auth tables.
CREATE TABLE IF NOT EXISTS pos_rewrite_administration_permissions (
 permission_key VARCHAR(201) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 app_label VARCHAR(100) NOT NULL, model VARCHAR(100) NOT NULL, codename VARCHAR(100) NOT NULL, name VARCHAR(255) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_administration_groups (
 id VARCHAR(36) NOT NULL PRIMARY KEY, name VARCHAR(150) NOT NULL, revision BIGINT UNSIGNED NOT NULL DEFAULT 1, legacy_id VARCHAR(32) NULL, updated_at DATETIME(3) NOT NULL,
 UNIQUE KEY uq_rewrite_admin_group_name(name), UNIQUE KEY uq_rewrite_admin_legacy_group(legacy_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_administration_group_permissions (
 group_id VARCHAR(36) NOT NULL, permission_key VARCHAR(201) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY(group_id,permission_key), INDEX ix_rewrite_admin_permission_group(permission_key,group_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_administration_memberships (
 operator_id VARCHAR(32) NOT NULL, group_id VARCHAR(36) NOT NULL,
 PRIMARY KEY(operator_id,group_id), INDEX ix_rewrite_admin_group_operator(group_id,operator_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_administration_direct_permissions (
 operator_id VARCHAR(32) NOT NULL, permission_key VARCHAR(201) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY(operator_id,permission_key), INDEX ix_rewrite_admin_direct_key(permission_key,operator_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_administration_access_reconciliation (
 id VARCHAR(16) NOT NULL PRIMARY KEY, verified BOOLEAN NOT NULL, source_fingerprint VARCHAR(64) NOT NULL,
 snapshot_hash VARCHAR(64) NOT NULL, operator_id VARCHAR(32) NOT NULL, request_id VARCHAR(128) NULL, counts JSON NOT NULL, completed_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_administration_access_mutations (
 id VARCHAR(36) NOT NULL PRIMARY KEY, actor_id VARCHAR(32) NOT NULL, resource_id VARCHAR(64) NOT NULL,
 action VARCHAR(32) NOT NULL, hash VARCHAR(64) NOT NULL, request_id VARCHAR(128) NULL, result JSON NOT NULL, created_at DATETIME(3) NOT NULL,
 INDEX ix_rewrite_admin_access_mutation_time(created_at)
) ENGINE=InnoDB;
INSERT IGNORE INTO pos_rewrite_administration_registries(resource) VALUES ('access-control');
