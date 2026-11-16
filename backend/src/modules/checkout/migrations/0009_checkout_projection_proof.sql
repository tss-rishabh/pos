-- Apply with the controlled migration role. The reviewed upstream transaction,
-- never the POS HTTP service, writes confirmations alongside allocations.
CREATE TABLE pos_rewrite_checkout_projections (
  order_id BIGINT NOT NULL PRIMARY KEY,
  store_id BIGINT NOT NULL,
  counter_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  input_hash CHAR(64) NOT NULL,
  line_count INT NOT NULL,
  contract_version VARCHAR(40) NOT NULL,
  confirmed_at DATETIME NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_checkout_projection_lines (
  order_id BIGINT NOT NULL,
  has_product_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  quantity BIGINT NOT NULL,
  input_hash CHAR(64) NOT NULL,
  PRIMARY KEY(order_id,has_product_id)
) ENGINE=InnoDB;
