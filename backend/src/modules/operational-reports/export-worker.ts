import { randomUUID } from 'node:crypto';
import { boundedJobWorker } from './job-worker.js';
import type { reportExportService } from './export-service.js';
import type { ReportExportOptions } from './export-storage.js';
export interface ReportExportWorkerEvent {
  module: 'operational-reports';
  resource: 'report-export';
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  exportId?: string;
  errorCode?: string;
}
export type ReportExportWorkerLogger = (
  level: 'info' | 'warn',
  event: ReportExportWorkerEvent,
  message: string,
) => void;
export function reportExportWorker(
  service: Pick<ReturnType<typeof reportExportService>, 'runOne'> &
    Partial<Pick<ReturnType<typeof reportExportService>, 'abortBuilds'>>,
  options: ReportExportOptions,
  log: ReportExportWorkerLogger,
) {
  const worker = boundedJobWorker(
    () => service.runOne(),
    options.REPORT_EXPORT_WORKER_INTERVAL_MS,
    3,
    (result, runId) =>
      log(
        result.status === 'FAILED' ? 'warn' : 'info',
        {
          module: 'operational-reports',
          resource: 'report-export',
          eventId: `operational-reports.report-export.${result.status.toLowerCase()}`,
          eventInstanceId: randomUUID(),
          requestId: result.requestId || runId,
          userId: result.userId,
          exportId: result.jobId,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        },
        'Report export processed',
      ),
    (runId) =>
      log(
        'warn',
        {
          module: 'operational-reports',
          resource: 'report-export',
          eventId: 'operational-reports.report-export.worker-failed',
          eventInstanceId: randomUUID(),
          requestId: runId,
          userId: null,
          errorCode: 'REPORT_EXPORT_WORKER_FAILED',
        },
        'Report export worker could not complete this pass',
      ),
  );
  return {
    ...worker,
    async stop() {
      service.abortBuilds?.();
      await worker.stop();
    },
  };
}
