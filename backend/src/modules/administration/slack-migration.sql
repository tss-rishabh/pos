-- Rewrite-owned ephemeral OAuth proof and completion receipts; no credential columns.
CREATE TABLE IF NOT EXISTS pos_rewrite_slack_connections (
 id VARCHAR(36) NOT NULL PRIMARY KEY,actor_id VARCHAR(32) NOT NULL,store_id VARCHAR(32) NOT NULL,
 state_hash VARCHAR(64) NOT NULL,state VARCHAR(16) NOT NULL,authentication_version VARCHAR(64) NOT NULL,session_binding VARCHAR(64) NOT NULL,
 store_version VARCHAR(64) NOT NULL,configuration_version VARCHAR(64) NOT NULL,
 request_id VARCHAR(36) NULL,error_code VARCHAR(64) NULL,lease_token VARCHAR(36) NULL,
 channel VARCHAR(255) NULL,channel_id VARCHAR(40) NULL,team_id VARCHAR(40) NULL,
 created_at DATETIME(3) NOT NULL,expires_at DATETIME(3) NOT NULL,completed_at DATETIME(3) NULL,
 UNIQUE KEY uq_pos_rewrite_slack_state(state_hash),
 KEY ix_pos_rewrite_slack_actor_store_state(actor_id,store_id,state),KEY ix_pos_rewrite_slack_expiry(expires_at)
) ENGINE=InnoDB;
