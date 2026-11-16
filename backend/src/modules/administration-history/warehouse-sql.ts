/** Deployment supplies a verified en-us source projection; only validated identifiers enter SQL. */
export function historicalAdministrationQuery(view: string, udf: string) {
  return `WITH filtered AS (
 SELECT id,action_time,action_time_mysql,actor_id,actor_username,actor_first_name,actor_last_name,action_flag,change_message
 FROM \`${view}\`
 WHERE \`${udf}\`(app_label,@appLabel,'app_label.exact')
 AND \`${udf}\`(model,@model,'model.exact') AND \`${udf}\`(object_id,@objectId,'object_id.exact')
 AND (@fromTime IS NULL OR action_time>=@fromTime) AND (@toTime IS NULL OR action_time<@toTime)
), counted AS (SELECT COUNT(*) AS total FROM filtered),
 pages AS (SELECT total,GREATEST(1,DIV(total,100)+IF(MOD(total,100)=0,0,1)) AS pages FROM counted),
 paging AS (SELECT total,pages,IF(@requestedPage IS NULL,1,IF(SAFE_CAST(@requestedPage AS INT64) IS NULL OR SAFE_CAST(@requestedPage AS INT64)<1 OR SAFE_CAST(@requestedPage AS INT64)>pages,pages,CAST(@requestedPage AS INT64))) AS page FROM pages),
 numbered AS (SELECT *,ROW_NUMBER() OVER(ORDER BY action_time ASC,CAST(id AS BIGNUMERIC) ASC) AS row_number FROM filtered)
 SELECT CAST(p.total AS STRING) AS total,CAST(p.page AS STRING) AS page,CAST(p.pages AS STRING) AS pages,
 IFNULL(ARRAY_AGG(IF(n.row_number IS NULL,NULL,STRUCT(
 CAST(n.id AS STRING) AS id,n.action_time_mysql AS actionTime,CAST(n.actor_id AS STRING) AS actorId,
 n.actor_username AS actorUsername,n.actor_first_name AS actorFirstName,n.actor_last_name AS actorLastName,
 n.action_flag AS actionFlag,n.change_message AS changeMessage
 )) IGNORE NULLS ORDER BY n.row_number),[]) AS data
 FROM paging p LEFT JOIN numbered n ON n.row_number>(p.page-1)*100 AND n.row_number-(p.page-1)*100<=100
 GROUP BY p.total,p.page,p.pages`;
}
