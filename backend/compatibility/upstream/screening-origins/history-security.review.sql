-- REVIEW ONLY. No automatic legacy DDL or account changes.
-- Dedicated trigger and audit definers MUST be ACCOUNT LOCK and have no roles.
-- Application accounts get SELECT(heads/changes), EXECUTE(this function), and
-- SHOW_ROUTINE metadata visibility; never direct control DML or trigger/routine
-- DDL. Grant source-table writes individually, not database-wide UPDATE/INSERT.
-- Use the explicit configured audit definer; replace this owner only during
-- reviewed installation. The function body itself remains byte-identical.
DELIMITER $$
CREATE DEFINER='pos_origin_history_audit'@'%' FUNCTION pos_rewrite_origin_history_metadata()
RETURNS JSON
READS SQL DATA
SQL SECURITY DEFINER
RETURN JSON_OBJECT(
 'triggers',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',name,'action',action,'sourceTable',sourceTable,'body',body,'owner',owner,'sqlMode',sqlMode)) FROM (
  SELECT TRIGGER_NAME AS name,EVENT_MANIPULATION AS action,EVENT_OBJECT_TABLE AS sourceTable,ACTION_STATEMENT AS body,DEFINER AS owner,SQL_MODE AS sqlMode
  FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
  ORDER BY TRIGGER_NAME LIMIT 1001
 ) trigger_rows),JSON_ARRAY()),
 'accounts',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',CONCAT(User,'@',Host),'locked',account_locked)) FROM (
  SELECT User,Host,account_locked FROM mysql.user ORDER BY User,Host LIMIT 1001
 ) account_rows),JSON_ARRAY()),
 'roles',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('name',CONCAT(TO_USER,'@',TO_HOST),'role',CONCAT(FROM_USER,'@',FROM_HOST))) FROM (
  SELECT TO_USER,TO_HOST,FROM_USER,FROM_HOST FROM mysql.role_edges ORDER BY TO_USER,TO_HOST,FROM_USER,FROM_HOST LIMIT 1001
 ) role_rows),JSON_ARRAY()),
 'privileges',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('grantee',grantee,'scope',scope,'schema',schemaName,'table',tableName,'privilege',privilegeName,'grantable',grantable)) FROM (
  SELECT GRANTEE AS grantee,'global' AS scope,'' AS schemaName,'' AS tableName,PRIVILEGE_TYPE AS privilegeName,IS_GRANTABLE AS grantable FROM INFORMATION_SCHEMA.USER_PRIVILEGES
  UNION ALL SELECT GRANTEE,'schema',TABLE_SCHEMA,'',PRIVILEGE_TYPE,IS_GRANTABLE FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE()
  UNION ALL SELECT GRANTEE,'table',TABLE_SCHEMA,TABLE_NAME,PRIVILEGE_TYPE,IS_GRANTABLE FROM INFORMATION_SCHEMA.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE()
  UNION ALL SELECT GRANTEE,'column',TABLE_SCHEMA,TABLE_NAME,PRIVILEGE_TYPE,IS_GRANTABLE FROM INFORMATION_SCHEMA.COLUMN_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE()
  LIMIT 1001
 ) privilege_rows),JSON_ARRAY()),
 'ownedRoutines',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('owner',DEFINER,'name',ROUTINE_NAME)) FROM (
  SELECT DEFINER,ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY DEFINER,ROUTINE_NAME LIMIT 1001
 ) routine_rows),JSON_ARRAY())
)
$$
DELIMITER ;
