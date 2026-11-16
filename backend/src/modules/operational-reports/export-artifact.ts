import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AppError } from '../../domain/errors.js';
import type { ReportFileFormat } from './export-format.js';

export interface ClosedExportFile {
  byteCount: number;
  checksum: string;
  open(signal?: AbortSignal): Promise<Readable>;
  dispose(): Promise<void>;
}
export type ExportArtifact =
  | { bytes: Buffer; rowCount: number; format?: 'CSV' }
  | { file: ClosedExportFile; rowCount: number; format: 'XLSX' };
export interface ExportBuildContext {
  jobId: string;
  signal: AbortSignal;
  maxBytes: number;
}
export interface PreparedExportArtifact {
  format: ReportFileFormat;
  byteCount: number;
  checksum: string;
  rowCount: number;
  bytes?: Buffer;
  file?: ClosedExportFile;
  dispose(): Promise<void>;
}
export function prepareExportArtifact(
  artifact: ExportArtifact,
  expected: ReportFileFormat,
  maxBytes: number,
): PreparedExportArtifact {
  const format = artifact.format || 'CSV',
    byteCount = 'bytes' in artifact ? artifact.bytes.length : artifact.file.byteCount,
    checksum =
      'bytes' in artifact
        ? createHash('sha256').update(artifact.bytes).digest('hex')
        : artifact.file.checksum;
  if (
    format !== expected ||
    !Number.isSafeInteger(artifact.rowCount) ||
    artifact.rowCount < 0 ||
    artifact.rowCount > (format === 'CSV' ? 70000 : 500 * 1048575) ||
    !Number.isSafeInteger(byteCount) ||
    byteCount < 0 ||
    (format === 'XLSX' && byteCount === 0) ||
    byteCount > maxBytes ||
    !/^[a-f0-9]{64}$/.test(checksum)
  )
    throw new AppError(
      422,
      'EXPORT_TOO_LARGE',
      'The report exceeds the allowed file or row limits.',
    );
  return {
    format,
    byteCount,
    checksum,
    rowCount: artifact.rowCount,
    ...('bytes' in artifact ? { bytes: artifact.bytes } : { file: artifact.file }),
    dispose: 'file' in artifact ? () => artifact.file.dispose() : async () => undefined,
  };
}
