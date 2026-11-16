export type ReportFileFormat = 'CSV' | 'XLSX';
export const xlsxContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export function reportFileFormat(kind: string): ReportFileFormat {
  return kind === 'current-inventory-workbook' ? 'XLSX' : 'CSV';
}
export function reportFileExtension(format: ReportFileFormat) {
  return format === 'XLSX' ? 'xlsx' : 'csv';
}
export function reportFileContentType(format: ReportFileFormat) {
  return format === 'XLSX' ? xlsxContentType : 'text/csv; charset=utf-8';
}
export function parsedReportFileFormat(value: string): ReportFileFormat | null {
  return value.toUpperCase() === 'CSV' ? 'CSV' : value.toUpperCase() === 'XLSX' ? 'XLSX' : null;
}
