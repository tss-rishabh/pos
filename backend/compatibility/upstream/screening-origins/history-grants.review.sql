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
-- Global metadata visibility is required to detect cross-schema aliases and
-- DBA-definer implicit executables. These rights belong ONLY to this isolated
-- locked account; no other object may use its definer and no PROXY/role may
-- expose it. The fixed function never returns credentials or unknown SQL bodies.
GRANT SELECT,SHOW VIEW,SHOW_ROUTINE,TRIGGER,EVENT ON *.* TO 'pos_origin_history_audit'@'%';
-- After installing the exact function from history-security.review.sql, grant
-- its locked definer EXECUTE on that function itself. MySQL requires this for
-- SQL SECURITY DEFINER execution; no other routine/global EXECUTE qualifies.
GRANT EXECUTE ON FUNCTION SOURCE_SCHEMA.pos_rewrite_origin_history_metadata TO 'pos_origin_history_audit'@'%';
-- Grant these individually to each participating app/readonly-origin account:
-- GRANT SHOW_ROUTINE ON *.* TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- GRANT EXECUTE ON FUNCTION SOURCE_SCHEMA.pos_rewrite_origin_history_metadata TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- GRANT SELECT ON SOURCE_SCHEMA.pos_rewrite_screening_origin_history_heads TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- GRANT SELECT ON SOURCE_SCHEMA.pos_rewrite_screening_origin_history_changes TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- No app roles, direct head/log DML, trigger/routine DDL or blanket schema DML.
-- Explicitly enumerate trusted DBA exceptions in the signed writer policy via
-- POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES; never auto-whitelist the caller.

-- Review all non-DBA global powers, mysql grant-table writes, database pattern
-- grants, indirect routine EXECUTE and privileged trigger/event/view exposure.
-- Default/system accounts with administrative powers must be explicitly reviewed
-- in ADMIN_GRANTEES too; locked accounts are not automatically trusted roles.
-- Qualified source callers/definers cannot be entries in that DBA exception list.
-- No mandatory roles, caller/definer role edges, current proxy sessions or proxy
-- routes into these accounts are accepted. Do not expose the audit owner as a
-- role: ACCOUNT LOCK alone does not prohibit definer execution or proxy use.
-- No updatable aliases to the control/grant tables, cascading foreign keys that
-- bypass the watched Order triggers, or incoming replication channels qualify.
-- A trusted DBA must coordinate a source write fence and drain existing sessions
-- before installing/changing these controls/grants. Previously created temporary
-- tables/session authority must not survive privilege cutover. Native source
-- admissions also check the actual protected objects with SHOW CREATE TABLE.
-- DBA maintenance/failover/plugins/replication need reviewed requalification;
-- this function cannot defend against a malicious unrestricted administrator.

-- When the stock sys.sys_config table is installed, source/app/projection
-- callers additionally need this one readonly metadata pin (never sys.*):
-- GRANT SELECT ON sys.sys_config TO 'ACTUAL_APP'@'ACTUAL_HOST';
-- Its two builtin mysql.sys@localhost BEFORE triggers are accepted only under
-- the closed 8.0.39 registry in origin_history_privileges.py: exact schema,
-- names/table/events/timing, normalized body SHA, locked owner and InnoDB base
-- table pinned with MDL+SHOW CREATE. mysql.sys@localhost must be explicitly
-- reviewed in ADMIN_GRANTEES, not inferred from the current caller. All other
-- DBA-owned implicit triggers/events/definer views with routines still refuse.
