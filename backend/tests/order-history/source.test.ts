import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('pinned source order date/store selection', () => {
  it('executes source datatable filtering and proves explicit dates and OrderStore association without source settings', () => {
    const value: unknown = JSON.parse(
      execFileSync('python3', ['tools/order-history/source_oracle.py'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(value).toMatchObject({
      pin: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
      calls: expect.arrayContaining([
        ['filter', { order_store__isnull: false }],
        ['filter', { order_store__store_id__in: [1] }],
        [
          'filter',
          { created_at__gte: '2026-11-16 00:00:00', created_at__lte: '2026-11-16 23:59:00' },
        ],
      ]),
    });
  });
});
