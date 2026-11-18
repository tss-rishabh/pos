import { describe, expect, it } from 'vitest';
import { goldenStdout } from '../golden/load.js';

describe('pinned return-window date and update semantics', () => {
  it('preserves exact tuple, end-of-day, native audit actor, shortening/reactivation and empty-date refusal', () => {
    const result = JSON.parse(goldenStdout('return-window', 'source')) as {
      pin: string;
      line: number;
      created: unknown;
      updated: unknown;
      rows: number;
      emptyDateRefused: boolean;
    };
    expect(result).toMatchObject({
      pin: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
      line: 4449,
      rows: 1,
      emptyDateRefused: true,
    });
    expect(result.created).toEqual({
      order_id: 100,
      prod_id: 123,
      has_product_id: 1000,
      extended_date: '2026-12-20 23:59:59',
      created_by: 88,
      updated_by: 88,
      is_active: 1,
    });
    expect(result.updated).toEqual({
      ...(result.created as object),
      extended_date: '2026-11-18 23:59:59',
    });
  });
});
