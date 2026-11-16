-- Transaction-bound proof that the contact/consent guard ran, including cash-only orders.
-- No legacy DDL or historical consent backfill.
CREATE TABLE IF NOT EXISTS pos_rewrite_checkout_customer_consents (
 order_id BIGINT NOT NULL PRIMARY KEY,
 store_id BIGINT NOT NULL,
 counter_id BIGINT NOT NULL,
 user_id BIGINT NOT NULL,
 operator_id BIGINT NULL,
 input_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 required TINYINT NOT NULL,
 contact_revision BIGINT UNSIGNED NULL,
 contact_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 verified_until_ms BIGINT NULL,
 accepted_at_ms BIGINT NOT NULL,
 contract_version VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 CONSTRAINT ck_checkout_consent_scope CHECK (order_id>0 AND store_id>0 AND counter_id>0 AND user_id>0 AND accepted_at_ms>0 AND (operator_id IS NULL OR operator_id>0)),
 CONSTRAINT ck_checkout_consent_binding CHECK (
  (required=0 AND contact_revision IS NULL AND contact_digest IS NULL AND verified_until_ms IS NULL)
  OR (required=1 AND operator_id IS NOT NULL AND operator_id>0 AND contact_revision IS NOT NULL AND contact_digest IS NOT NULL AND verified_until_ms IS NOT NULL
   AND verified_until_ms>accepted_at_ms AND verified_until_ms<=accepted_at_ms+900000)
 )
) ENGINE=InnoDB;
