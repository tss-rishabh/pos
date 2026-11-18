import { describe, it, expect } from 'vitest';
import snapshot from './source-snapshot.json';
import {
  orderSearchPage,
  sourceOrderRow,
  sourcePageCsv,
} from '../../src/pages/order-history/search-client';
describe('portable source-pinned order list contract', () => {
  it('reads committed real Django source snapshots without a sibling source checkout', () => {
    expect(snapshot.sourcePin).toBe('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a');
    expect(snapshot.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    const data = snapshot.response.data.map((row, index) =>
      sourceOrderRow.parse({ ...row, rowKey: row.id + ':' + index, actionStoreId: '1' }),
    );
    expect(data.filter((row) => row.id === '102')).toHaveLength(6);
    expect(data.find((row) => row.id === '101')?.payment_methods__name).toBe(
      'Cash: CASH + Online (Other) +UPI',
    );
    expect(
      orderSearchPage.safeParse({
        contract: 'pos-source-order-search-v1',
        ...snapshot.response,
        data,
        page: 1,
        pageSize: 25,
        reader: 'primary',
        fetchedAt: '2026-11-17T06:00:00Z',
        range: {
          placedFrom: '2026-11-17 00:00:00',
          placedTo: '2026-11-18 00:00:00',
          timeZone: 'Asia/Kolkata',
          ignoredForQueue: false,
        },
      }).success,
    ).toBe(true);
  });
  it('preserves source spaces/duplicates in page export and protects formula text', () => {
    const row = sourceOrderRow.parse({
      ...snapshot.response.data[0],
      rowKey: 'synthetic',
      actionStoreId: '1',
      user__firstname: '=HYPERLINK("unsafe")',
    });
    const csv = sourcePageCsv([row, row], ['id', 'user__firstname', 'payment_methods__name']);
    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).toContain('"\'=HYPERLINK(""unsafe"")"');
  });
});
