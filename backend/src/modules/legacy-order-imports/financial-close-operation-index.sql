-- Rewrite-only access path. Keep every contradictory close impact visible.
CREATE INDEX ix_import_financial_close_operation
ON pos_rewrite_import_financial_close_impacts(operation_id);
