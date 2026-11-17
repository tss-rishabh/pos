-- REVIEW TEMPLATE, not executable configuration. Replace the schema/account
-- placeholders through DBA review; never apply using the supplied reader SA.
-- Existing broad grants must be removed separately before application cutover.
-- The trigger/procedure owner and publisher are independent from app accounts.
GRANT SELECT ON `SOURCE_SCHEMA`.pos_rewrite_screening_counter_heads TO 'APPLICATION'@'HOST';
GRANT SELECT ON `SOURCE_SCHEMA`.pos_rewrite_screening_counters TO 'APPLICATION'@'HOST';
GRANT SELECT ON `SOURCE_SCHEMA`.pos_rewrite_screening_contributions TO 'APPLICATION'@'HOST';
-- Metadata visibility only. The sealed definer must remain the reviewed owner.
GRANT TRIGGER ON `SOURCE_SCHEMA`.orders TO 'APPLICATION'@'HOST';
GRANT TRIGGER ON `SOURCE_SCHEMA`.has_products TO 'APPLICATION'@'HOST';
GRANT TRIGGER ON `SOURCE_SCHEMA`.spiderman_screening_orders TO 'APPLICATION'@'HOST';
GRANT SHOW_ROUTINE ON *.* TO 'APPLICATION'@'HOST';
-- Application: NO EXECUTE, projection INSERT/UPDATE/DELETE/column writes,
-- schema/global DML/DDL, active roles, GRANT OPTION, SUPER/definer-changing grants.
-- It keeps narrowly scoped source/control-table DML needed by existing features.
-- Only the trigger definer receives EXECUTE on pos_screening_sync_marker and
-- projection/head DML. Only the independent publisher may initialize/reconcile
-- projection tables from an authenticated complete BigQuery generation.
