import { describe, expect, it, vi } from 'vitest';
import {
  catalogMaintenanceWorker,
  type CatalogMaintenanceEvent,
} from '../../src/modules/catalog-details/maintenance-worker.js';
import { catalogMaintenanceOptions } from '../../src/modules/catalog-details/maintenance-options.js';
describe('catalog maintenance worker observability', () => {
  it('logs static resources, actor/request IDs and opaque command IDs without payloads or raw errors', async () => {
    const records: CatalogMaintenanceEvent[] = [],
      service = {
        runOne: vi
          .fn()
          .mockResolvedValueOnce({
            commandId: '5e8df376-ed51-40e8-95fa-858040d06192',
            kind: 'inventory-pull',
            state: 'UNCERTAIN',
            requestId: 'fixture-trace',
            userId: '1',
            errorCode: 'CATALOG_DELIVERY_OUTCOME_UNKNOWN',
            customerEmail: 'fixture@example.test',
            payload: 'secret body',
          })
          .mockResolvedValueOnce(null),
      };
    const worker = catalogMaintenanceWorker(
      service,
      catalogMaintenanceOptions({}),
      (_level, event) => records.push(event),
    );
    await worker.runOnce();
    await worker.stop();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      module: 'catalog-details',
      resource: 'inventory-pull',
      eventId: 'catalog-details.inventory-pull.uncertain',
      requestId: 'fixture-trace',
      userId: '1',
    });
    expect(JSON.stringify(records)).not.toContain('fixture@example.test');
    records.length = 0;
    const malformed = catalogMaintenanceWorker(
      {
        runOne: vi
          .fn()
          .mockResolvedValueOnce({
            commandId: '5e8df376-ed51-40e8-95fa-858040d06192',
            kind: 'inventory-pull',
            state: 'UNCERTAIN',
            requestId: 'fixture-trace',
            userId: '1',
            errorCode: 'fixture@example.test secret error',
          })
          .mockResolvedValueOnce(null),
      },
      catalogMaintenanceOptions({}),
      (_level, event) => records.push(event),
    );
    await malformed.runOnce();
    await malformed.stop();
    expect(records[0]?.eventId).toBe('catalog-details.catalog-maintenance.worker-failed');
    expect(JSON.stringify(records)).not.toContain('fixture@example.test');
    expect(JSON.stringify(records)).not.toContain('secret body');
    records.length = 0;
    const failed = catalogMaintenanceWorker(
      {
        runOne: async () => {
          throw new Error('fixture@example.test secret error');
        },
      },
      catalogMaintenanceOptions({}),
      (_level, event) => records.push(event),
    );
    await failed.runOnce();
    await failed.stop();
    expect(records[0]).toMatchObject({
      eventId: 'catalog-details.catalog-maintenance.worker-failed',
      userId: 'service-catalog-maintenance',
    });
    expect(JSON.stringify(records)).not.toContain('fixture@example.test');
  });
});
