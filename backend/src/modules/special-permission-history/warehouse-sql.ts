/** Identifiers come only from the validated deployment options; every requested filter is bound. */
export function historicalActivityQuery(
  view: string,
  udf: string | undefined,
  hasPlatforms: boolean,
  hasSearch: boolean,
) {
  const platform = hasPlatforms
    ? `EXISTS(SELECT 1 FROM UNNEST(@platforms) AS p WHERE \`${udf}\`(platform,p,'platform.in'))`
    : 'TRUE';
  const match = hasSearch
    ? '(' +
      ['recipient', 'comment', 'platform', 'created_at_mysql']
        .map(
          (field) =>
            `\`${udf}\`(${field},@pattern,'${field === 'created_at_mysql' ? 'created_at' : field}.icontains')`,
        )
        .join(' OR ') +
      ')'
    : 'TRUE';
  return `WITH filtered AS (
  SELECT id,actor_exists,actor_first_name,actor_last_name,platform,comment,created_at_mysql,recipient
  FROM \`${view}\`
  WHERE (@fromTime IS NULL OR created_at>=@fromTime) AND (@toTime IS NULL OR created_at<@toTime)
    AND ${platform} AND ${match}
 ), counted AS (SELECT COUNT(*) AS total FROM filtered),
 paging AS (SELECT total,IF(@start<0 OR MOD(@start,@length)<>0 OR @start>=total,0,@start) AS actual_start FROM counted),
 numbered AS (SELECT *,ROW_NUMBER() OVER(ORDER BY CAST(id AS BIGNUMERIC) ASC) AS row_number FROM filtered)
 SELECT CAST(p.total AS STRING) AS total,CAST(p.actual_start AS STRING) AS actual_start,
 IFNULL(ARRAY_AGG(IF(n.row_number IS NULL,NULL,STRUCT(
  CAST(n.id AS STRING) AS id,n.actor_exists AS actorExists,n.actor_first_name AS firstName,
  n.actor_last_name AS lastName,n.platform AS platform,n.comment AS comment,
  n.created_at_mysql AS createdAt,n.recipient AS recipient
 )) IGNORE NULLS ORDER BY n.row_number),[]) AS data
 FROM paging p LEFT JOIN numbered n
 ON n.row_number>p.actual_start AND n.row_number<=p.actual_start+@length
 GROUP BY p.total,p.actual_start`;
}
