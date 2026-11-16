import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  reportExportWorker,
  type ReportExportWorkerEvent,
} from '../../src/modules/operational-reports/export-worker.js';
import { reportExportOptions } from '../../src/modules/operational-reports/export-storage.js';
describe('bounded report export worker', () => {
  it('does not overlap work and propagates request/user tracing without report values', async () => {
    let release: (() => void) | undefined,
      calls = 0;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      events: ReportExportWorkerEvent[] = [],
      jobId = randomUUID(),
      worker = reportExportWorker(
        {
          async runOne() {
            calls++;
            if (calls > 1) return null;
            await gate;
            return {
              jobId,
              status: 'COMPLETED',
              requestId: 'fixture-request',
              userId: '900001',
              errorCode: null,
            };
          },
        },
        reportExportOptions({}),
        (_level, event) => events.push(event),
      );
    const first = worker.runOnce(),
      second = worker.runOnce();
    expect(first).toBe(second);
    expect(calls).toBe(1);
    release?.();
    await first;
    await worker.stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      module: 'operational-reports',
      resource: 'report-export',
      eventId: 'operational-reports.report-export.completed',
      requestId: 'fixture-request',
      userId: '900001',
      exportId: jobId,
    });
    expect(events[0]).not.toHaveProperty('input');
  });
  it('keeps raw dependency errors out of worker events', async () => {
    const events: ReportExportWorkerEvent[] = [],
      worker = reportExportWorker(
        {
          async runOne() {
            throw new Error('secret SQL text and object URL');
          },
        },
        reportExportOptions({}),
        (_level, event) => events.push(event),
      );
    await worker.runOnce();
    await worker.stop();
    expect(events[0]).toMatchObject({
      eventId: 'operational-reports.report-export.worker-failed',
      errorCode: 'REPORT_EXPORT_WORKER_FAILED',
      userId: null,
    });
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});
