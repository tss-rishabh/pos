import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  inventoryPullBody,
  inventoryPullSelection,
  temporarySourceBarcode,
} from '../../src/modules/catalog-details/maintenance-domain.js';
import { catalogMaintenanceOptions } from '../../src/modules/catalog-details/maintenance-options.js';
import { createCatalogMaintenanceTransports } from '../../src/modules/catalog-details/maintenance-transports.js';
import { goldenStdout } from '../golden/load.js';
describe('catalog maintenance source profiles and bounded transports', () => {
  it('preserves source manual/CSV payload differences, deduplication and simple-SKU filtering', () => {
    const products = [
      { id: 1, prod_type: 1 },
      { id: 2, prod_type: 3 },
      { id: 3, prod_type: 1 },
    ];
    for (const input of [
      { mode: 'manual' as const, skus: ' 3,1,1,2,999, ' },
      { mode: 'csv' as const, filename: 'fixture.csv', csv: 'sku\n3\n1\n1\n2\n999\n' },
    ]) {
      const expected = JSON.parse(
        goldenStdout(
          'catalog-details',
          'maintenance-domain',
          JSON.stringify({ kind: 'inventory-pull', products, ...input }),
        ),
      ) as { payloads: unknown[] };
      const selection = inventoryPullSelection(input),
        ids = selection.ids.filter((id) => ['1', '3'].includes(id)),
        body = inventoryPullBody({ kind: 'inventory-pull', mode: selection.mode, productIds: ids });
      expect(JSON.parse(body) as unknown).toEqual(expected.payloads[0]);
      expect(selection.requestedCount).toBe(5);
      expect(selection.uniqueRequestedCount).toBe(4);
    }
    expect(
      inventoryPullBody({
        kind: 'inventory-pull',
        mode: 'manual',
        productIds: ['9007199254740993'],
      }),
    ).toBe('{"productIds":[9007199254740993],"priority":1}');
  });
  it('validates every SKU and CSV boundary before mutation and refuses unsafe GTIN rewrites', () => {
    expect(() =>
      inventoryPullSelection({
        mode: 'manual',
        skus: Array.from({ length: 41 }, () => '1').join(','),
      }),
    ).toThrow('at most 40');
    expect(() => inventoryPullSelection({ mode: 'manual', skus: '1,,2' })).toThrow(
      'positive numeric',
    );
    expect(() =>
      inventoryPullSelection({ mode: 'csv', filename: 'fixture.csv', csv: 'sku\n' }),
    ).toThrow('at least one');
    expect(() =>
      inventoryPullSelection({
        mode: 'csv',
        filename: 'fixture.csv',
        csv: 'email\nfixture@example.test',
      }),
    ).toThrow('sku header');
    expect(temporarySourceBarcode('123')).toBe('1230123');
    expect(() => temporarySourceBarcode('9223372036854775807')).toThrow('exceeds');
  });
  it('posts the legacy inventory payload with the API key to an approved endpoint and returns the status', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'maintenance-transport-fixture-'.repeat(3),
      }),
      options = catalogMaintenanceOptions({
        INVENTORY_SYNC_URL: 'http://127.0.0.1:9999/pull',
        INVENTORY_SYNC_API_KEY: 'fixture-key',
      }),
      fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 202 })),
      send = createCatalogMaintenanceTransports(config, options, {}, fetcher).inventory!;
    expect(await send(['1'], 'csv')).toBe(202);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: '{"productIds":[1]}',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'fixture-key' },
    });
    await send(['1', '2'], 'manual');
    expect(fetcher.mock.calls[1]![1]?.body).toBe('{"productIds":[1,2],"priority":1}');
    fetcher.mockImplementationOnce(async () => {
      throw new Error('network');
    });
    await expect(send(['1'], 'csv')).rejects.toThrow();
    expect(() =>
      createCatalogMaintenanceTransports(
        config,
        { ...options, INVENTORY_SYNC_URL: 'https://external.invalid/pull' },
        {},
        fetcher,
      ),
    ).toThrow('approved inventory');
    expect(() =>
      createCatalogMaintenanceTransports(
        { ...config, DEMO_MODE: false },
        { ...options, INVENTORY_SYNC_URL: 'https://external.invalid/pull?key=secret' },
        {},
        fetcher,
      ),
    ).toThrow('approved inventory');
  });
});
