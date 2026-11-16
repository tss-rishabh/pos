import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import {
  scheduledReportBuilder,
  freshdeskReader,
} from '../../src/modules/operational-reports/scheduled-data.js';
import { scheduledReportOptions } from '../../src/modules/operational-reports/scheduled-options.js';
import { scheduleInput } from '../../src/modules/operational-reports/scheduled-domain.js';
const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'scheduled-view-fixture-'.repeat(3),
  }),
  options = scheduledReportOptions(
    Object.fromEntries(
      [
        'ORDER_FACTS',
        'ORDER_LOGS',
        'AVAILABILITY',
        'DELIVERY_ISSUES',
        'CANCELLATIONS',
        'CRM_TICKETS',
      ].map((value) => [
        `BQ_HYPERLOCAL_${value}_VIEW`,
        `fixture-project.reports.${value.toLowerCase()}`,
      ]),
    ),
  ),
  clock = () => Temporal.Instant.from('2026-11-17T08:00:00Z');
describe('scheduled-report warehouse contracts', () => {
  it('routes history through bound compatible views while keeping current configuration separate', async () => {
    let mysql = 0;
    const calls: { statement: string; params: Record<string, unknown>; resource?: string }[] = [],
      db: Databases = {
        get() {
          mysql++;
          throw new Error('Historical MySQL forbidden');
        },
        close: async () => {},
      },
      builder = scheduledReportBuilder(
        config,
        db,
        options,
        {
          async queryReport(
            statement: string,
            params: Record<string, unknown>,
            _types: Record<string, string | string[]>,
            resource?: string,
          ) {
            calls.push({ statement, params, resource });
            return [];
          },
        },
        undefined,
        clock,
        async () => ({ stores: [], slots: [] }),
      );
    for (const kind of [
      'hyperlocal-performance',
      'hyperlocal-summary',
      'hyperlocal-availability',
      'hyperlocal-delivery-delays',
      'hyperlocal-cancellations',
    ] as const)
      await builder({ ...scheduleInput.parse({ kind }), date: '2026-11-16' });
    expect(mysql).toBe(0);
    expect(calls).toHaveLength(6);
    expect(
      calls.every(
        (call) =>
          call.params.from === '2026-11-16 00:00:00' && call.params.end === '2026-11-17 00:00:00',
      ),
    ).toBe(true);
    expect(calls[1]?.params.windowStart).toBe('2026-11-15 00:00:00');
    expect(calls[0]?.statement).toContain('fixture-project.reports.order_logs');
    expect(calls[1]?.statement).toContain('ROW_NUMBER() OVER');
    expect(calls.map((call) => call.resource)).toEqual([
      'hyperlocal-performance',
      'hyperlocal-summary',
      'hyperlocal-availability',
      'hyperlocal-availability',
      'hyperlocal-delivery-delays',
      'hyperlocal-cancellations',
    ]);
    await builder({
      ...scheduleInput.parse({ kind: 'hyperlocal-store-status' }),
      date: '2026-11-17',
    });
    expect(calls).toHaveLength(6);
    const missing = scheduledReportBuilder(
      config,
      db,
      scheduledReportOptions({}),
      undefined,
      undefined,
      clock,
      async () => ({ stores: [], slots: [] }),
    );
    await expect(
      missing({ ...scheduleInput.parse({ kind: 'hyperlocal-cancellations' }), date: '2026-11-16' }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(mysql).toBe(0);
  });
  it('sanitizes malformed views/transport errors and disables demo Freshdesk traffic', async () => {
    const db: Databases = {
        get() {
          throw new Error('Historical MySQL forbidden');
        },
        close: async () => {},
      },
      builder = scheduledReportBuilder(
        config,
        db,
        options,
        {
          async queryReport() {
            throw new Error('secret warehouse filter');
          },
        },
        undefined,
        clock,
      );
    await expect(
      builder({ ...scheduleInput.parse({ kind: 'hyperlocal-cancellations' }), date: '2026-11-16' }),
    ).rejects.toMatchObject({
      code: 'SCHEDULED_REPORT_QUERY_FAILED',
      message: 'The scheduled report could not be prepared.',
    });
    await expect(
      freshdeskReader(config, options)('901', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(() => scheduledReportOptions({ SLACK_URL: 'https://evil.example.test/hook' })).toThrow();
    expect(() =>
      scheduledReportOptions({
        FRESHDESK_TICKET_URL: 'http://user:secret@private.example.test/tickets',
      }),
    ).toThrow();
  });
});
