CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_receipt_lines (
  receipt_id VARCHAR(36) NOT NULL,
  store_id VARCHAR(32) NOT NULL,
  product_id VARCHAR(32) NOT NULL,
  quantity SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (receipt_id,product_id),
  KEY ix_offline_cash_pending_stock (store_id,product_id,receipt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

INSERT INTO pos_rewrite_offline_cash_receipt_lines (receipt_id,store_id,product_id,quantity)
SELECT receipts.id,receipts.store_id,line_items.product_id,line_items.quantity
FROM pos_rewrite_offline_cash_receipts AS receipts
JOIN JSON_TABLE(receipts.receipt_json,'$.receipt.lines[*]' COLUMNS (
  product_id VARCHAR(32) PATH '$.productId',
  quantity INT PATH '$.quantity'
)) AS line_items
ON TRUE;

CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_signing_keys (
  key_id VARCHAR(64) PRIMARY KEY,
  public_key_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS pos_rewrite_offline_cash_import_proofs (
  receipt_id VARCHAR(36) PRIMARY KEY,
  order_id VARCHAR(32) NOT NULL,
  key_id VARCHAR(64) NOT NULL,
  proof_json MEDIUMTEXT NOT NULL,
  signature VARCHAR(86) NOT NULL,
  created_at_ms BIGINT NOT NULL,
  UNIQUE KEY uq_offline_cash_import_proof_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
