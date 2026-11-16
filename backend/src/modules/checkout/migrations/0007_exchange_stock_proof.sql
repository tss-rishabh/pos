-- This proof is written by the reviewed upstream payment compatibility patch in
-- the same transaction as stock decrement, line placement and paid status.
-- The rewrite never backfills it from a success response or mutable stock count.
CREATE TABLE IF NOT EXISTS pos_rewrite_exchange_stock_confirmations (
  order_id BIGINT PRIMARY KEY,
  parent_order_id BIGINT NOT NULL,
  parent_has_product_id BIGINT NOT NULL,
  has_product_id BIGINT NOT NULL,
  store_id BIGINT NOT NULL,
  counter_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  quantity BIGINT NOT NULL,
  contract_version VARCHAR(40) NOT NULL,
  confirmed_at DATETIME NOT NULL,
  INDEX ix_exchange_stock_parent (parent_order_id, parent_has_product_id, order_id)
) ENGINE=InnoDB;
