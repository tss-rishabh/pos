-- REVIEW ONLY. Install under the same locked audit definer as the full metadata function.
-- The exact function body exposes only the current connection's instrumented
-- transaction, never other threads, history, SQL text or business rows.
DELIMITER $$
CREATE DEFINER='pos_origin_history_audit'@'%' FUNCTION pos_rewrite_origin_transaction_metadata()
RETURNS JSON
READS SQL DATA
SQL SECURITY DEFINER
RETURN COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('state',transactionState,'isolation',isolationLevel)) FROM (
 SELECT e.STATE AS transactionState,e.ISOLATION_LEVEL AS isolationLevel
 FROM performance_schema.events_transactions_current e
 JOIN performance_schema.threads t ON t.THREAD_ID=e.THREAD_ID
 WHERE t.PROCESSLIST_ID=CONNECTION_ID() AND t.INSTRUMENTED='YES'
 AND (SELECT COUNT(*) FROM performance_schema.setup_consumers WHERE NAME IN ('global_instrumentation','thread_instrumentation','events_transactions_current') AND ENABLED='YES')=3
 AND (SELECT COUNT(*) FROM performance_schema.setup_instruments WHERE NAME='transaction' AND ENABLED='YES')=1
 ORDER BY e.THREAD_ID LIMIT 2
) transaction_rows),JSON_ARRAY())
$$
DELIMITER ;
