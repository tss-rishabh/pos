-- REVIEW ONLY. No automatic legacy DDL or account changes.
-- Dedicated trigger and audit definers MUST be ACCOUNT LOCK and have no roles
-- or proxy exposure. The audit definer exposes only this fixed readonly body.
-- Every array has a 1001 sentinel; the consumer rejects >1000, never truncates
-- an over-capacity installation into an apparently complete privilege proof.
-- Only the four source trigger bodies are returned. Other reviewed head writers
-- expose hashes/identities, never arbitrary SQL bodies, credentials or rows.
-- Use the explicit configured audit definer; replace this owner only during
-- reviewed installation. The function body itself remains byte-identical.
DELIMITER $$
CREATE DEFINER='pos_origin_history_audit'@'%' FUNCTION pos_rewrite_origin_history_metadata()
RETURNS JSON
READS SQL DATA
SQL SECURITY DEFINER
RETURN /* native-head-capacity:a32ccc71a7b9a3893331c03342e090f1830ea830cbcf32919ec449f35f86b3ad */ JSON_OBJECT(
 'triggers',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',name,'action',action,'sourceTable',sourceTable,'body',body,'owner',owner,'sqlMode',sqlMode)) FROM (
  SELECT TRIGGER_NAME AS name,EVENT_MANIPULATION AS action,EVENT_OBJECT_TABLE AS sourceTable,ACTION_STATEMENT AS body,DEFINER AS owner,SQL_MODE AS sqlMode
  FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_origin_history_user_i','pos_rewrite_origin_history_order_i','pos_rewrite_origin_history_order_d','pos_rewrite_origin_history_order_u')
  ORDER BY TRIGGER_NAME LIMIT 1001
 ) trigger_rows),JSON_ARRAY()),
 'membershipTriggers',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',name,'tableName',tableName,'event',eventName,'timing',timing,'hash',bodyHash,'definer',owner,'sqlMode',sqlMode)) FROM (
  SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS tableName,EVENT_MANIPULATION AS eventName,ACTION_TIMING AS timing,
   LOWER(SHA2(ACTION_STATEMENT,256)) AS bodyHash,DEFINER AS owner,SQL_MODE AS sqlMode
  FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'pos_rewrite_member_history_%'
  ORDER BY TRIGGER_NAME LIMIT 1001
 ) membership_trigger_rows),JSON_ARRAY()),
 'membershipRevisionTriggers',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',name,'tableName',tableName,'event',eventName,'timing',timing,'hash',bodyHash,'definer',owner,'sqlMode',sqlMode)) FROM (
  SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS tableName,EVENT_MANIPULATION AS eventName,ACTION_TIMING AS timing,
   LOWER(SHA2(ACTION_STATEMENT,256)) AS bodyHash,DEFINER AS owner,SQL_MODE AS sqlMode
  FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_mem_eav_insert','pos_rewrite_mem_eav_update','pos_rewrite_mem_eav_delete','pos_rewrite_mem_user_email')
  ORDER BY TRIGGER_NAME LIMIT 1001
 ) membership_revision_trigger_rows),JSON_ARRAY()),
 'couponTriggers',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',name,'tableName',tableName,'event',eventName,'timing',timing,'hash',bodyHash,'definer',owner,'sqlMode',sqlMode)) FROM (
  SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS tableName,EVENT_MANIPULATION AS eventName,ACTION_TIMING AS timing,
   LOWER(SHA2(TRIM(REGEXP_REPLACE(ACTION_STATEMENT,'[[:space:]]+',' ')),256)) AS bodyHash,DEFINER AS owner,SQL_MODE AS sqlMode
  FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'pos_rewrite_coupon_history_%'
  ORDER BY TRIGGER_NAME LIMIT 1001
 ) coupon_trigger_rows),JSON_ARRAY()),
 'counterTriggers',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',name,'tableName',tableName,'event',eventName,'timing',timing,'hash',bodyHash,'definer',owner,'sqlMode',sqlMode)) FROM (
  SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS tableName,EVENT_MANIPULATION AS eventName,ACTION_TIMING AS timing,
   LOWER(SHA2(TRIM(REGEXP_REPLACE(ACTION_STATEMENT,'[[:space:]]+',' ')),256)) AS bodyHash,DEFINER AS owner,SQL_MODE AS sqlMode
  FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'pos_screening_%'
  ORDER BY TRIGGER_NAME LIMIT 1001
 ) counter_trigger_rows),JSON_ARRAY()),
 'counterProcedures',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',name,'kind',kind,'security',security,'hash',bodyHash,'definer',owner)) FROM (
  SELECT ROUTINE_NAME AS name,ROUTINE_TYPE AS kind,SECURITY_TYPE AS security,DEFINER AS owner,
   LOWER(SHA2(TRIM(REGEXP_REPLACE(ROUTINE_DEFINITION,'[[:space:]]+',' ')),256)) AS bodyHash
  FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='pos_screening_sync_marker'
  ORDER BY ROUTINE_NAME LIMIT 1001
 ) counter_procedure_rows),JSON_ARRAY()),
 'platformTriggers',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('schema',schemaName,'name',name,'tableName',tableName,'event',eventName,'timing',timing,'definer',owner,'hash',bodyHash,'locked',locked,'tableKind',tableKind,'tableEngine',tableEngine)) FROM (
  SELECT r.TRIGGER_SCHEMA AS schemaName,r.TRIGGER_NAME AS name,r.EVENT_OBJECT_TABLE AS tableName,r.EVENT_MANIPULATION AS eventName,r.ACTION_TIMING AS timing,r.DEFINER AS owner,
   LOWER(SHA2(TRIM(REGEXP_REPLACE(r.ACTION_STATEMENT,'[[:space:]]+',' ')),256)) AS bodyHash,u.account_locked AS locked,t.TABLE_TYPE AS tableKind,t.ENGINE AS tableEngine
  FROM INFORMATION_SCHEMA.TABLES t LEFT JOIN INFORMATION_SCHEMA.TRIGGERS r ON r.TRIGGER_SCHEMA=t.TABLE_SCHEMA AND r.TRIGGER_NAME IN ('sys_config_insert_set_user','sys_config_update_set_user')
  LEFT JOIN mysql.user u ON CONCAT(u.User,'@',u.Host)=r.DEFINER
  WHERE t.TABLE_SCHEMA='sys' AND t.TABLE_NAME='sys_config' ORDER BY r.TRIGGER_NAME LIMIT 1001
 ) platform_trigger_rows),JSON_ARRAY()),
 'accounts',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',CONCAT(User,'@',Host),'locked',account_locked)) FROM (
  SELECT User,Host,account_locked FROM mysql.user ORDER BY User,Host LIMIT 1001
 ) account_rows),JSON_ARRAY()),
 'roles',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',CONCAT(TO_USER,'@',TO_HOST),'role',CONCAT(FROM_USER,'@',FROM_HOST))) FROM (
  SELECT TO_USER,TO_HOST,FROM_USER,FROM_HOST FROM mysql.role_edges ORDER BY TO_USER,TO_HOST,FROM_USER,FROM_HOST LIMIT 1001
 ) role_rows),JSON_ARRAY()),
 'proxies',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',CONCAT(User,'@',Host),'target',CONCAT(Proxied_user,'@',Proxied_host),'grantable',With_grant)) FROM (
  SELECT User,Host,Proxied_user,Proxied_host,With_grant FROM mysql.proxies_priv ORDER BY User,Host,Proxied_user,Proxied_host LIMIT 1001
 ) proxy_rows),JSON_ARRAY()),
 'privileges',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('grantee',grantee,'scope',scope,'schema',schemaName,'table',tableName,'column',columnName,'privilege',privilegeName,'grantable',grantable,
 'target',CASE WHEN scope='global' THEN 'global'
  WHEN scope='schema' AND (schemaName=DATABASE() OR schemaName='mysql' OR DATABASE() LIKE schemaName ESCAPE X'5C' OR 'mysql' LIKE schemaName ESCAPE X'5C') THEN 'protected-schema'
  WHEN scope IN ('table','column') AND schemaName='mysql' THEN 'grants'
  WHEN scope IN ('table','column') AND schemaName=DATABASE() AND tableName IN ('pos_rewrite_screening_origin_history_heads','pos_rewrite_screening_origin_history_changes','pos_rewrite_membership_history_heads','pos_rewrite_coupon_history_heads','pos_rewrite_screening_counter_heads','pos_rewrite_screening_counters','pos_rewrite_screening_contributions') THEN 'control'
  WHEN scope IN ('table','column') AND schemaName=DATABASE() AND tableName IN ('orders','users','has_products','order_coupon_log','coupons','spiderman_screening_orders','user_eav','pos_rewrite_membership_versions') THEN 'watched'
  ELSE 'other' END)) FROM (
  SELECT GRANTEE AS grantee,'global' AS scope,'' AS schemaName,'' AS tableName,'' AS columnName,PRIVILEGE_TYPE AS privilegeName,IS_GRANTABLE AS grantable FROM INFORMATION_SCHEMA.USER_PRIVILEGES
  UNION ALL SELECT GRANTEE,'schema',TABLE_SCHEMA,'','',PRIVILEGE_TYPE,IS_GRANTABLE FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES
  UNION ALL SELECT GRANTEE,'table',TABLE_SCHEMA,TABLE_NAME,'',PRIVILEGE_TYPE,IS_GRANTABLE FROM INFORMATION_SCHEMA.TABLE_PRIVILEGES
  UNION ALL SELECT GRANTEE,'column',TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,PRIVILEGE_TYPE,IS_GRANTABLE FROM INFORMATION_SCHEMA.COLUMN_PRIVILEGES
  LIMIT 4097
 ) privilege_rows),JSON_ARRAY()),
 'routineGrants',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',CONCAT(User,'@',Host),'schema',Db,'routine',Routine_name,'kind',Routine_type,'privileges',CAST(Proc_priv AS CHAR))) FROM (
  SELECT User,Host,Db,Routine_name,Routine_type,Proc_priv FROM mysql.procs_priv ORDER BY User,Host,Db,Routine_name,Routine_type LIMIT 1001
 ) routine_grant_rows),JSON_ARRAY()),
 'objects',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('schema',schemaName,'name',name,'kind',kind,'owner',owner,'security',security,'usesRoutines',usesRoutines)) FROM (
  SELECT ROUTINE_SCHEMA AS schemaName,ROUTINE_NAME AS name,ROUTINE_TYPE AS kind,DEFINER AS owner,SECURITY_TYPE AS security,0 AS usesRoutines FROM INFORMATION_SCHEMA.ROUTINES
  UNION ALL SELECT v.TABLE_SCHEMA,v.TABLE_NAME,'VIEW',v.DEFINER,v.SECURITY_TYPE,EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.VIEW_ROUTINE_USAGE r WHERE r.TABLE_SCHEMA=v.TABLE_SCHEMA AND r.TABLE_NAME=v.TABLE_NAME) FROM INFORMATION_SCHEMA.VIEWS v
  UNION ALL SELECT TRIGGER_SCHEMA,TRIGGER_NAME,'TRIGGER',DEFINER,'DEFINER',0 FROM INFORMATION_SCHEMA.TRIGGERS
  UNION ALL SELECT EVENT_SCHEMA,EVENT_NAME,'EVENT',DEFINER,'DEFINER',0 FROM INFORMATION_SCHEMA.EVENTS
  LIMIT 1001
 ) object_rows),JSON_ARRAY()),
 'aliases',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('schema',VIEW_SCHEMA,'name',VIEW_NAME,'sourceSchema',TABLE_SCHEMA,'sourceTable',TABLE_NAME)) FROM (
  SELECT VIEW_SCHEMA,VIEW_NAME,TABLE_SCHEMA,TABLE_NAME FROM INFORMATION_SCHEMA.VIEW_TABLE_USAGE
  WHERE (TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('pos_rewrite_screening_origin_history_heads','pos_rewrite_screening_origin_history_changes','pos_rewrite_membership_history_heads','pos_rewrite_coupon_history_heads','pos_rewrite_screening_counter_heads','pos_rewrite_screening_counters','pos_rewrite_screening_contributions'))
   OR (TABLE_SCHEMA='mysql' AND TABLE_NAME IN ('user','db','tables_priv','columns_priv','procs_priv','proxies_priv','global_grants','role_edges','default_roles','password_history','func'))
  ORDER BY VIEW_SCHEMA,VIEW_NAME,TABLE_SCHEMA,TABLE_NAME LIMIT 1001
 ) alias_rows),JSON_ARRAY()),
 'tables',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',TABLE_NAME,'kind',TABLE_TYPE,'engine',ENGINE)) FROM (
  SELECT TABLE_NAME,TABLE_TYPE,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_NAME IN ('orders','users','has_products','order_coupon_log','coupons','spiderman_screening_orders','pos_rewrite_screening_origin_history_heads','pos_rewrite_screening_origin_history_changes','pos_rewrite_membership_history_heads','pos_rewrite_coupon_history_heads','pos_rewrite_screening_counter_heads','pos_rewrite_screening_counters','pos_rewrite_screening_contributions') OR (TABLE_NAME IN ('user_eav','pos_rewrite_membership_versions') AND EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_mem_eav_insert','pos_rewrite_mem_eav_update','pos_rewrite_mem_eav_delete','pos_rewrite_mem_user_email'))))
  ORDER BY TABLE_NAME LIMIT 1001
 ) table_rows),JSON_ARRAY()),
 'foreignKeys',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('table',TABLE_NAME,'column',COLUMN_NAME,'update',UPDATE_RULE,'delete',DELETE_RULE)) FROM (
  SELECT k.TABLE_NAME,k.COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
  JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME
  WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL AND (k.TABLE_NAME IN ('orders','users','has_products','order_coupon_log','coupons','spiderman_screening_orders','pos_rewrite_screening_origin_history_heads','pos_rewrite_screening_origin_history_changes','pos_rewrite_membership_history_heads','pos_rewrite_coupon_history_heads','pos_rewrite_screening_counter_heads','pos_rewrite_screening_counters','pos_rewrite_screening_contributions') OR (k.TABLE_NAME IN ('user_eav','pos_rewrite_membership_versions') AND EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_mem_eav_insert','pos_rewrite_mem_eav_update','pos_rewrite_mem_eav_delete','pos_rewrite_mem_user_email'))))
  ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION LIMIT 1001
 ) foreign_key_rows),JSON_ARRAY()),
 'replicationChannels',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',CHANNEL_NAME,'state',SERVICE_STATE)) FROM (
  SELECT CHANNEL_NAME,SERVICE_STATE FROM performance_schema.replication_applier_status ORDER BY CHANNEL_NAME LIMIT 1001
 ) replication_rows),JSON_ARRAY())
)
$$
DELIMITER ;
