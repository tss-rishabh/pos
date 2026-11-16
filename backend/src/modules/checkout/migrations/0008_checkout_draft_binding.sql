ALTER TABLE pos_rewrite_checkout_sessions
  ADD COLUMN client_draft_id VARCHAR(36) NULL,
  ADD UNIQUE INDEX ux_checkout_operator_draft (operator_id, client_draft_id);
