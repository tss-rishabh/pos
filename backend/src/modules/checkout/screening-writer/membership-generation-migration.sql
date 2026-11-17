-- Rewrite-only encrypted publication infrastructure. No source identity/history DDL.
CREATE TABLE IF NOT EXISTS pos_rewrite_public_membership_generations (
 id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 version BIGINT UNSIGNED NOT NULL,
 phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload LONGTEXT NOT NULL,
 proof CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 lease_until_ms BIGINT NOT NULL,
 updated_at_ms BIGINT NOT NULL,
 KEY ix_public_member_generation_pending(phase,lease_until_ms,updated_at_ms,id)
) ENGINE=InnoDB;
