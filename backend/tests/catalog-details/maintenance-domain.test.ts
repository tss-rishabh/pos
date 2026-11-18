import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  inventoryPullBody,
  inventoryPullSelection,
  temporarySourceBarcode,
} from '../../src/modules/catalog-details/maintenance-domain.js';
import { catalogMaintenanceOptions } from '../../src/modules/catalog-details/maintenance-options.js';
import {
  createCatalogMaintenanceTransports,
  MaintenanceDeliveryError,
} from '../../src/modules/catalog-details/maintenance-transports.js';
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
  it('uses approved endpoints, captured trace/idempotency headers and uncertain outcomes without leaking failures', async () => {
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
      transport = createCatalogMaintenanceTransports(config, options, {}, fetcher).inventory!;
    const payload = { kind: 'inventory-pull' as const, mode: 'csv' as const, productIds: ['1'] },
      context = { deliveryId: crypto.randomUUID(), requestId: 'fixture-request', userId: '1' };
    await transport.send(payload, context);
    const call = fetcher.mock.calls[0]!;
    expect(call[1]).toMatchObject({
      redirect: 'error',
      body: '{"productIds":[1]}',
      headers: {
        'x-api-key': 'fixture-key',
        'Idempotency-Key': context.deliveryId,
        'X-Request-Id': 'fixture-request',
      },
    });
    fetcher.mockImplementationOnce(async () => {
      throw new Error('fixture@example.test secret body');
    });
    await expect(transport.send(payload, context)).rejects.toMatchObject({
      outcome: 'uncertain',
      code: 'INVENTORY_PULL_OUTCOME_UNKNOWN',
    });
    expect(new MaintenanceDeliveryError('uncertain', 'fixture@example.test').code).toBe(
      'CATALOG_DELIVERY_OUTCOME_UNKNOWN',
    );
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
