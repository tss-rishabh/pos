-- REVIEW ONLY. Replace SOURCE_SCHEMA and reviewed administrator/host names;
-- never execute from the application or the strictly readonly publisher SA.
-- Install/cut over triggers and bootstrap heads under a coordinated write fence.
CREATE USER 'pos_origin_history_trigger'@'%' ACCOUNT LOCK;
CREATE USER 'pos_origin_history_audit'@'%' ACCOUNT LOCK;
GRANT SELECT,TRIGGER ON SOURCE_SCHEMA.orders TO 'pos_origin_history_trigger'@'%';
GRANT SELECT,TRIGGER ON SOURCE_SCHEMA.users TO 'pos_origin_history_trigger'@'%';
GRANT SELECT,INSERT,UPDATE ON SOURCE_SCHEMA.pos_rewrite_screening_origin_history_heads TO 'pos_origin_history_trigger'@'%';
GRANT INSERT ON SOURCE_SCHEMA.pos_rewrite_screening_origin_history_changes TO 'pos_origin_history_trigger'@'%';
-- The audit definer cannot log in. Its only caller-visible operation is the
-- literal READS SQL DATA JSON function, whose owner/body are verified natively.
GRANT SELECT ON mysql.* TO 'pos_origin_history_audit'@'%';
GRANT TRIGGER ON SOURCE_SCHEMA.* TO 'pos_origin_history_audit'@'%';
-- Grant these individually to each participating app/readonly-origin account:
-- GRANT SHOW_ROUTINE ON *.* TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- GRANT EXECUTE ON FUNCTION SOURCE_SCHEMA.pos_rewrite_origin_history_metadata TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- GRANT SELECT ON SOURCE_SCHEMA.pos_rewrite_screening_origin_history_heads TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- GRANT SELECT ON SOURCE_SCHEMA.pos_rewrite_screening_origin_history_changes TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- No app roles, direct head/log DML, trigger/routine DDL or blanket schema DML.
-- Explicitly enumerate trusted DBA exceptions in the signed writer policy via
-- POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES; never auto-whitelist the caller.
