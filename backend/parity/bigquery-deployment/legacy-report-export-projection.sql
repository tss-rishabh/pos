-- Reviewed nonfinancial SELECT projection only. No reader activation or publication attestation.
-- Source: tssgcp2025.tss_mysql_raw_layer.tss_report_exports
SELECT CAST(id AS STRING) AS id,
    report_type AS kind,
    COALESCE(NULLIF(report_name,''),NULLIF(report_type,''),'Legacy report') AS report_name,
    CAST(NULL AS STRING) AS note,CAST(NULL AS STRING) AS period_start,CAST(NULL AS STRING) AS period_end,
    CASE WHEN is_completed<>0 THEN 'COMPLETED' WHEN UPPER(export_status) IN ('FAILED','ERROR') THEN 'FAILED' ELSE 'QUEUED' END AS status,
    CAST(export_requested_by AS STRING) AS operator_id,
    export_requested_at AS requested_at,export_completed_at AS completed_at,
    COALESCE(export_completed_at,updated_at,export_requested_at) AS terminal_at,
    export_format AS format,
    IF(export_size<0 OR export_size>8796093022207,ERROR('INVALID_EXPORT_SIZE'),export_size*1024) AS byte_count,
    export_rows_count AS row_count
  FROM `tssgcp2025.tss_mysql_raw_layer.tss_report_exports`;
