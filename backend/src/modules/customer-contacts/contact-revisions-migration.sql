-- Perpetual customer contact fencing only; no legacy account or financial DDL.
CREATE TABLE IF NOT EXISTS pos_rewrite_customer_contact_revisions (
 customer_id VARCHAR(32) NOT NULL PRIMARY KEY,
 revision BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
