import { z } from 'zod';

export const observedLegacyExportRawTable = 'tssgcp2025.tss_mysql_raw_layer.tss_report_exports';
const relation = z
  .string()
  .regex(/^(?:[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_]\w*\.)?[A-Za-z_]\w*$/);
/**
 * Nonfinancial source-column projection for a reviewed publisher/CTE.
 * This is NOT a publication/freshness attestation and does not activate a reader.
 * No file key, provider message, time_period JSON or contact field is selected.
 */
export function rawLegacyExportProjection(source = observedLegacyExportRawTable) {
  const table = '`' + relation.parse(source) + '`';
  return `SELECT CAST(id AS STRING) AS id,
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
  FROM ${table}`;
}
/** Metadata query used only after a separate complete-source publication contract exists. */
export function rawLegacyExportValidationQuery() {
  return `WITH source_projection AS (${rawLegacyExportProjection()})
  SELECT id,kind,report_name,note,period_start,period_end,status,operator_id,
    CAST(requested_at AS STRING) AS requested_at,CAST(completed_at AS STRING) AS completed_at,
    CAST(terminal_at AS STRING) AS terminal_at,format,byte_count,row_count
  FROM source_projection
  WHERE status IN ('COMPLETED','FAILED') AND terminal_at>=@start AND terminal_at<@end
    AND (@allOwners OR operator_id=@owner)
  ORDER BY terminal_at DESC,id DESC LIMIT @limit`;
}
