import type { JobModuleRegistration } from '../../jobs/runtime.js';
import { legacyExports, type ReportExportKind } from './export-domain.js';
import { reportExportService } from './export-service.js';
import { createReportExportStore, reportExportOptions } from './export-storage.js';

/**
 * Report export jobs E1-E6 (`report.datatables.*`, phase-c-legacy-jobs.md §2.6). Each handler is
 * the legacy task body: it creates the report_exports row, builds and uploads the CSV, then
 * records completion (or `FAILED` where legacy has a failure branch).
 */
export const registerJobHandlers: JobModuleRegistration = (registry, runtime) => {
  const options = reportExportOptions(),
    store = createReportExportStore(runtime.config, options),
    service = reportExportService(runtime.config, runtime.db, options, store, runtime.jobs);
  for (const [kind, spec] of Object.entries(legacyExports) as [
    ReportExportKind,
    (typeof legacyExports)[ReportExportKind],
  ][])
    registry.register(spec.job, async (args, context) => {
      const exportId = await service.run(kind, args);
      runtime.log(
        'info',
        {
          module: 'operational-reports',
          resource: 'report-export',
          eventId: 'operational-reports.report-export.completed',
          jobId: context.jobId,
          requestId: context.requestId,
          userId: context.userId,
          exportId,
        },
        'Report export completed',
      );
    });
};
