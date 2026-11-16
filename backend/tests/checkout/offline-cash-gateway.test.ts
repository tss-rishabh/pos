import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertOfflineCashReady,
  offlineCashEnvironment,
  offlineCashPriceSource,
  type OfflineCashPriceRequest,
} from '../../src/modules/checkout/offline-cash/gateway.js';
import { offlineCashFixture } from './offline-cash-fixtures.js';

function environment() {
  return offlineCashEnvironment({
    OFFLINE_CASH_SIGNING_KEY_PEM: generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString(),
    OFFLINE_CASH_MAX_RECEIPT_CENTS: '100000',
    OFFLINE_CASH_MAX_TOTAL_CENTS: '1000000',
    OFFLINE_CASH_RECEIPT_COUNT: '100',
    OFFLINE_CASH_AUTH_TTL_SECONDS: '600',
    OFFLINE_CASH_MAX_QUANTITY: '2',
    TSS_OFFLINE_CASH_PRICING_URL:
      'https://pricing.example.test/internal/pos/offline-cash-price-snapshots',
    TSS_OFFLINE_CASH_SOURCE_KEY: 'fixture-offline-source-key-'.repeat(3),
    UPSTREAM_POS_OFFLINE_CASH_PRICING_CONTRACT: 'pos-offline-cash-prices-v1',
    UPSTREAM_POS_OFFLINE_CASH_IMPORT_CONTRACT: 'pos-offline-cash-import-v1',
  });
}
function request(): OfflineCashPriceRequest {
  const { snapshot } = offlineCashFixture();
  return {
    snapshotId: snapshot.id,
    operatorId: '44',
    storeId: '1',
    counterId: '2',
    productIds: snapshot.products.map((product) => product.productId),
    quantities: [1, 2],
    businessDate: snapshot.businessDate,
    issuedAt: snapshot.issuedAt,
    expiresAt: snapshot.expiresAt,
  };
}
describe('offline cash private source pricing boundary', () => {
  it('sends only the explicit private pricing request, forbids redirects and preserves exact source unit/quantity values', async () => {
    const value = environment(),
      input = request(),
      snapshot = offlineCashFixture().snapshot;
    const calls: { url: string; options: RequestInit }[] = [];
    const source = offlineCashPriceSource({ NODE_ENV: 'test' }, value, async (url, options) => {
      calls.push({ url: String(url), options: options! });
      return new Response(JSON.stringify(snapshot));
    });
    expect(await source(input)).toEqual(snapshot);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(value.TSS_OFFLINE_CASH_PRICING_URL);
    expect(calls[0]!.url).not.toContain(value.TSS_OFFLINE_CASH_SOURCE_KEY);
    expect(calls[0]!.options.redirect).toBe('error');
    expect(JSON.parse(calls[0]!.options.body as string)).toEqual(input);
    expect(new Headers(calls[0]!.options.headers).get('X-POS-Offline-Key')).toBe(
      value.TSS_OFFLINE_CASH_SOURCE_KEY,
    );
  });
  it('fails before any source request when contracts, limits or secure endpoint configuration are missing', async () => {
    expect(() => assertOfflineCashReady(offlineCashEnvironment({}))).toThrow(
      'verified pricing/import',
    );
    for (const priceUrl of [
      'http://pricing.example.test/snapshots',
      'https://user:SECRET-CANARY@pricing.example.test/snapshots',
      'https://pricing.example.test/snapshots?key=SECRET-CANARY',
    ]) {
      let calls = 0;
      const source = offlineCashPriceSource(
        { NODE_ENV: 'production' },
        { ...environment(), TSS_OFFLINE_CASH_PRICING_URL: priceUrl },
        async () => {
          calls++;
          throw new Error('Unexpected dispatch');
        },
      );
      await expect(source(request())).rejects.toMatchObject({
        code: 'OFFLINE_CASH_NOT_CONFIGURED',
      });
      expect(calls).toBe(0);
    }
  });
  it('accepts only an exact disjoint eligible/excluded partition of the requested SKUs', async () => {
    const snapshot = offlineCashFixture().snapshot,
      input = { ...request(), productIds: [...request().productIds, '390238'] };
    const accepted = { ...snapshot, excludedProductIds: ['390238'] };
    expect(
      await offlineCashPriceSource(
        { NODE_ENV: 'test' },
        environment(),
        async () => new Response(JSON.stringify(accepted)),
      )(input),
    ).toEqual(accepted);
    for (const invalid of [
      snapshot,
      { ...accepted, excludedProductIds: ['390238', '390238'] },
      { ...accepted, excludedProductIds: ['390238', snapshot.products[0]!.productId] },
    ])
      await expect(
        offlineCashPriceSource(
          { NODE_ENV: 'test' },
          environment(),
          async () => new Response(JSON.stringify(invalid)),
        )(input),
      ).rejects.toMatchObject({ code: 'OFFLINE_CASH_PRICING_UNAVAILABLE' });
  });
  it('rejects changed scope/missing source quantities and never exposes upstream body or exception data', async () => {
    const snapshot = offlineCashFixture().snapshot,
      value = environment();
    for (const response of [
      { ...snapshot, storeId: '3' },
      {
        ...snapshot,
        products: [
          { ...snapshot.products[0]!, quantities: [snapshot.products[0]!.quantities[0]!] },
        ],
      },
    ]) {
      await expect(
        offlineCashPriceSource(
          { NODE_ENV: 'test' },
          value,
          async () => new Response(JSON.stringify(response)),
        )(request()),
      ).rejects.toMatchObject({ code: 'OFFLINE_CASH_PRICING_UNAVAILABLE' });
    }
    const secret = 'UPSTREAM-PII-SECRET-CANARY@example.test';
    try {
      await offlineCashPriceSource(
        { NODE_ENV: 'test' },
        value,
        async () => new Response(secret, { status: 503 }),
      )(request());
      throw new Error('Unexpected success');
    } catch (error) {
      expect(error).toMatchObject({ code: 'OFFLINE_CASH_PRICING_UNAVAILABLE' });
      expect(String(error)).not.toContain(secret);
    }
  });
});
