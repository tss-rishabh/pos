-- Rewrite-only native journal/approval/order-owner/effect evidence.
-- No legacy table, trigger, procedure or historical row is altered/backfilled.
CREATE TABLE pos_rewrite_import_financial_operations (
 id VARCHAR(36) PRIMARY KEY,actor_id VARCHAR(32) NOT NULL,store_id VARCHAR(32) NOT NULL,counter_id VARCHAR(32) NOT NULL,
 plan_hash VARCHAR(64) NOT NULL,request_hash VARCHAR(64) NOT NULL,namespace VARCHAR(64) NOT NULL,payload MEDIUMTEXT NOT NULL,state JSON NOT NULL,
 created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_import_financial_namespace(namespace),KEY ix_import_financial_scope(actor_id,store_id,created_at_ms,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_import_financial_source_effects (
 operation_id VARCHAR(36) PRIMARY KEY,payload MEDIUMTEXT NOT NULL,effects_hash VARCHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL,deliveries JSON NOT NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_import_financial_approvals (
 id VARCHAR(36) PRIMARY KEY,operation_id VARCHAR(36) NOT NULL,command_id VARCHAR(36) NOT NULL,request_hash VARCHAR(64) NOT NULL,plan_hash VARCHAR(64) NOT NULL,
 data JSON NOT NULL,authority JSON NOT NULL,approver_version VARCHAR(64) NOT NULL,proof_hash VARCHAR(64) NOT NULL,created_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_import_financial_approval_command(command_id),KEY ix_import_financial_approval_operation(operation_id,created_at_ms,id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_import_financial_stages (
 id VARCHAR(80) PRIMARY KEY,operation_id VARCHAR(36) NOT NULL,kind VARCHAR(16) NOT NULL,nonce VARCHAR(36) NOT NULL,status VARCHAR(16) NOT NULL,
 request_hash VARCHAR(64) NOT NULL,proof_hash VARCHAR(64) NULL,proof JSON NULL,created_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_import_financial_stage(operation_id,kind)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_import_financial_source_receipts (
 id VARCHAR(80) PRIMARY KEY,operation_id VARCHAR(36) NOT NULL,kind VARCHAR(16) NOT NULL,request_hash VARCHAR(64) NOT NULL,status VARCHAR(16) NOT NULL,
 proof JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,created_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_import_financial_source(operation_id,kind)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_import_financial_proofs (
 id VARCHAR(36) PRIMARY KEY,operation_id VARCHAR(36) NOT NULL,order_id VARCHAR(32) NOT NULL,request_hash VARCHAR(64) NOT NULL,
 data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,finalized_at_ms BIGINT NOT NULL,
 UNIQUE KEY uq_import_financial_proof_operation(operation_id),UNIQUE KEY uq_import_financial_proof_order(order_id)
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_import_financial_references (
 id VARCHAR(64) PRIMARY KEY,operation_id VARCHAR(36) NOT NULL,plan_hash VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_import_financial_close_impacts (
 id VARCHAR(100) PRIMARY KEY,operation_id VARCHAR(36) NOT NULL,close_id VARCHAR(32) NOT NULL,close_version VARCHAR(16) NOT NULL,created_at_ms BIGINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_import_financial_order_bindings (
 order_id VARCHAR(32) PRIMARY KEY,operation_id VARCHAR(36) NOT NULL,request_hash VARCHAR(64) NOT NULL,proof_hash VARCHAR(64) NOT NULL,status VARCHAR(16) NOT NULL,
 UNIQUE KEY uq_import_financial_order_operation(operation_id)
) ENGINE=InnoDB;
