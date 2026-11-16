-- Reviewed additive candidate only; not part of automatic migrations.
-- Verify existing indexes and online-DDL support before production deployment.
CREATE INDEX ix_pos_gv_history_order_voucher
  ON gift_voucher_history (order_id, gv_id, id);
