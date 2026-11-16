-- Keep first-dispatch claims ordered while excluding completed delivery history.
CREATE INDEX ix_payment_outbox_pending
 ON pos_rewrite_payment_outbox(status,created_at,id,kind);
