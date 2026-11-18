-- REVIEW TEMPLATE, not executable configuration. Replace the schema/account
-- placeholders through DBA review; never apply using the supplied reader SA.
-- Existing broad grants must be removed separately before application cutover.
-- The trigger/procedure owner and publisher are independent from app accounts.
GRANT SELECT ON `SOURCE_SCHEMA`.pos_rewrite_screening_counter_heads TO 'APPLICATION'@'HOST';
GRANT SELECT ON `SOURCE_SCHEMA`.pos_rewrite_screening_counters TO 'APPLICATION'@'HOST';
GRANT SELECT ON `SOURCE_SCHEMA`.pos_rewrite_screening_contributions TO 'APPLICATION'@'HOST';
-- Metadata comes from the reviewed readonly function, not DDL-capable TRIGGER
-- grants. Install its locked owners and common policy through the separate
-- screening-origins/history-security/head-participant review deployment.
GRANT EXECUTE ON FUNCTION `SOURCE_SCHEMA`.pos_rewrite_origin_history_metadata TO 'APPLICATION'@'HOST';
GRANT SHOW_ROUTINE ON *.* TO 'APPLICATION'@'HOST';
-- Application: NO other routine EXECUTE, projection INSERT/UPDATE/DELETE/column writes,
-- schema/global DML/DDL, active roles, GRANT OPTION, SUPER/definer-changing grants.
-- It keeps narrowly scoped source/control-table DML needed by existing features.
-- Only the trigger definer receives EXECUTE on pos_screening_sync_marker and
-- projection/head DML. Only the independent publisher may initialize/reconcile
-- projection tables from an authenticated complete BigQuery generation.
-- Install screening-origins/transaction-security.review.sql under the same locked
-- audit owner. It must own only the two reviewed fixed readonly metadata functions.
GRANT EXECUTE ON FUNCTION `SOURCE_SCHEMA`.pos_rewrite_origin_transaction_metadata TO 'APPLICATION'@'HOST';
GRANT EXECUTE ON FUNCTION `SOURCE_SCHEMA`.pos_rewrite_origin_transaction_metadata TO 'SOURCE_READER'@'HOST';
GRANT EXECUTE ON FUNCTION `SOURCE_SCHEMA`.pos_rewrite_origin_transaction_metadata TO 'PROJECTION_PUBLISHER'@'HOST';
GRANT EXECUTE ON FUNCTION `SOURCE_SCHEMA`.pos_rewrite_origin_transaction_metadata TO 'AUDIT_DEFINER'@'HOST';
GRANT EXECUTE ON FUNCTION `SOURCE_SCHEMA`.pos_rewrite_origin_transaction_metadata TO 'COUNTER_DEFINER'@'HOST';
-- No direct performance_schema SELECT, PROCESS or other routine EXECUTE for the
-- counter definer. The audited readonly audit definer has its existing SELECT.
