import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { boundedJobWorker } from '../operational-reports/job-worker.js';
import type { catalogMaintenanceService } from './maintenance-service.js';
import type { CatalogMaintenanceOptions } from './maintenance-options.js';
const loggedResult = z.object({
  commandId: z.uuid(),
  kind: z.enum(['inventory-pull', 'product-troubleshoot']),
  state: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'UNCERTAIN', 'FAILED']),
  requestId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  userId: z.string().regex(/^[1-9]\d{0,19}$/),
  errorCode: z
    .enum([
      'INVALID_INVENTORY_DELIVERY',
      'INVENTORY_PULL_NOT_ACKNOWLEDGED',
      'INVENTORY_PULL_OUTCOME_UNKNOWN',
      'INVALID_PRODUCT_DELIVERY',
      'PRODUCT_SYNC_OUTCOME_UNKNOWN',
      'CATALOG_DELIVERY_OUTCOME_UNKNOWN',
      'CATALOG_DELIVERY_MISSING',
      'CATALOG_DELIVERY_INVALID',
      'CATALOG_DELIVERY_KIND_INVALID',
      'CATALOG_DELIVERY_TARGET_CHANGED',
      'CATALOG_REPAIR_PROOF_MISSING',
      'CATALOG_OPERATOR_REVOKED',
      'INVENTORY_PULL_SELECTION_CHANGED',
      'CATALOG_DELIVERY_SEQUENCE_INVALID',
    ])
    .nullable(),
});
export interface CatalogMaintenanceEvent {
  module: 'catalog-details';
  resource: 'inventory-pull' | 'product-troubleshoot' | 'catalog-maintenance';
  eventId: string;
  eventInstanceId: string;
  requestId: string;
  userId: string;
  commandId?: string;
  errorCode?: string;
}
export type CatalogMaintenanceLogger = (
  level: 'info' | 'warn',
  event: CatalogMaintenanceEvent,
  message: string,
) => void;
export function catalogMaintenanceWorker(
  service: Pick<ReturnType<typeof catalogMaintenanceService>, 'runOne'>,
  options: CatalogMaintenanceOptions,
  log: CatalogMaintenanceLogger,
) {
  const failed = (runId: string) =>
    log(
      'warn',
      {
        module: 'catalog-details',
        resource: 'catalog-maintenance',
        eventId: 'catalog-details.catalog-maintenance.worker-failed',
        eventInstanceId: randomUUID(),
        requestId: runId,
        userId: 'service-catalog-maintenance',
        errorCode: 'CATALOG_MAINTENANCE_WORKER_FAILED',
      },
      'Catalog maintenance worker could not complete this pass',
    );
  return boundedJobWorker(
    () => service.runOne(),
    options.CATALOG_MAINTENANCE_INTERVAL_MS,
    2,
    (value, runId) => {
      const parsed = loggedResult.safeParse(value);
      if (!parsed.success) {
        failed(runId);
        return;
      }
      const result = parsed.data;
      log(
        result.state === 'UNCERTAIN' || result.state === 'FAILED' ? 'warn' : 'info',
        {
          module: 'catalog-details',
          resource: result.kind,
          eventId: 'catalog-details.' + result.kind + '.' + result.state.toLowerCase(),
          eventInstanceId: randomUUID(),
          requestId: result.requestId || runId,
          userId: result.userId,
          commandId: result.commandId,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        },
        'Catalog maintenance delivery processed',
      );
    },
    failed,
  );
}
