-- Funded physical-card evidence is committed with payment and voucher activation.
-- Later collection block/redemption does not erase the original funding proof.
CREATE TABLE IF NOT EXISTS pos_rewrite_gift_card_issuances (
  voucher_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  collection_id BIGINT NOT NULL,
  serial BIGINT NOT NULL,
  input_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  contract_version VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  activated_at DATETIME NOT NULL,
  PRIMARY KEY (voucher_id),
  INDEX gift_issuance_order (order_id, voucher_id),
  INDEX gift_issuance_collection (collection_id, voucher_id)
) ENGINE=InnoDB;
