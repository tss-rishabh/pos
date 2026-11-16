CREATE TABLE IF NOT EXISTS pos_rewrite_staff_download_grants (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 operator_id BIGINT NOT NULL, qr_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 auth_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, artifact_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, request_id VARCHAR(128) NULL,
 state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 expires_at BIGINT UNSIGNED NOT NULL, activation_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 activation_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL, activation_expires_at BIGINT UNSIGNED NULL,
 download_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 created_at BIGINT UNSIGNED NOT NULL, updated_at BIGINT UNSIGNED NOT NULL,
 UNIQUE KEY uq_staff_download_operation(operation_id), UNIQUE KEY uq_staff_download_qr(qr_digest),
 UNIQUE KEY uq_staff_download_activation(activation_digest), KEY ix_staff_download_operator_state(operator_id,state,expires_at), KEY ix_staff_download_expiry(expires_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_application_links (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, store_id BIGINT NOT NULL,
 token_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_by BIGINT NOT NULL, request_id VARCHAR(128) NULL, created_at BIGINT UNSIGNED NOT NULL,
 UNIQUE KEY uq_customer_application_store(store_id), UNIQUE KEY uq_customer_application_token(token_digest)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_application_cache (
 store_id BIGINT PRIMARY KEY, provider_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, configuration_version CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 target VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, expires_at BIGINT UNSIGNED NOT NULL,
 lease_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, lease_until BIGINT UNSIGNED NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS pos_rewrite_application_scan_receipts (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, link_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 store_id BIGINT NOT NULL, target VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL, source_log_id INT NULL, request_id VARCHAR(128) NULL,
 created_at BIGINT UNSIGNED NOT NULL, KEY ix_application_scan_receipt_created(created_at)
) ENGINE=InnoDB;
