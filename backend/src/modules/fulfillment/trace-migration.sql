-- Forward-only rewrite-state change: retain complete bounded workflow trace IDs.
ALTER TABLE pos_rewrite_notification_events
  MODIFY COLUMN request_id VARCHAR(128) NULL;
ALTER TABLE pos_rewrite_fulfillment_effects
  MODIFY COLUMN request_id VARCHAR(128) NULL;
