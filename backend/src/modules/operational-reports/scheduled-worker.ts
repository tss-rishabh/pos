import { randomUUID } from 'node:crypto';
import type { scheduledReportService } from './scheduled-service.js';
import type { ScheduledReportOptions } from './scheduled-options.js';
import { boundedJobWorker } from './job-worker.js';
export interface ScheduledWorkerEvent {
  module: 'operational-reports';
  resource: 'scheduled-report-delivery';
  eventId: string;
  eventInstanceId: string;
  requestId: string;
  userId: string;
  jobId?: string;
  kind?: string;
  errorCode?: string;
}
export type ScheduledWorkerLogger = (
  level: 'info' | 'warn',
  event: ScheduledWorkerEvent,
  message: string,
) => void;
export function scheduledReportWorker(
  service: Pick<ReturnType<typeof scheduledReportService>, 'runOne'>,
  options: ScheduledReportOptions,
  log: ScheduledWorkerLogger,
) {
  return boundedJobWorker(
    () => service.runOne(),
    options.SCHEDULED_REPORT_WORKER_INTERVAL_MS,
    3,
    (result, runId) =>
      log(
        result.status === 'FAILED' || result.status === 'DELIVERY_UNKNOWN' ? 'warn' : 'info',
        {
          module: 'operational-reports',
          resource: 'scheduled-report-delivery',
          eventId:
            'operational-reports.scheduled-report-delivery.' +
            result.status.toLowerCase().replaceAll('_', '-'),
          eventInstanceId: randomUUID(),
          requestId: result.requestId || runId,
          userId: result.userId,
          jobId: result.jobId,
          kind: result.kind,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        },
        'Scheduled report job processed',
      ),
    (runId) =>
      log(
        'warn',
        {
          module: 'operational-reports',
          resource: 'scheduled-report-delivery',
          eventId: 'operational-reports.scheduled-report-delivery.worker-failed',
          eventInstanceId: randomUUID(),
          requestId: runId,
          userId: 'service-reports',
          errorCode: 'SCHEDULED_REPORT_WORKER_FAILED',
        },
        'Scheduled report worker could not complete this pass',
      ),
  );
}
