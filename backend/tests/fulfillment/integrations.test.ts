import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { effectRequest } from '../../src/modules/fulfillment/integrations.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';
import type { EffectDelivery } from '../../src/modules/fulfillment/outbox.js';
const config = {
  ...readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'effect-request-fixture-'.repeat(3),
  }),
  TSS_API_BASE_URL: 'https://warehouse.example.test/',
};
const options = {
  ...readFulfillmentOptions({}),
  BACKEND_SYNC_API_BASE_URL: 'https://sync.example.test',
  BACKEND_SYNC_REPO_API_KEY: 'fixture-sync-key',
  MJML_HOST: 'https://mailr.example.test/',
  PREORDER_URL: 'https://preorder.example.test/',
  PREORDER_INTERNAL_KEY: 'fixture-preorder-key',
  API_V2_APP_ID: 'fixture-warehouse-id',
  API_V2_APP_KEY: 'fixture-warehouse-key',
};
function delivery(
  kind: EffectDelivery['kind'],
  payload: EffectDelivery['payload'],
): EffectDelivery {
  return {
    effectId: crypto.randomUUID(),
    commandId: crypto.randomUUID(),
    operatorId: '1',
    storeId: '12',
    orderId: '1001',
    kind,
    payload,
    priorResults: [],
  };
}
describe('external fulfillment request contracts', () => {
  it('matches original status, RTO, mailr and signed-delta helpers using an inert Python request recorder', () => {
    const cases = [
      {
        kind: 'status-api' as const,
        payload: { orderId: '1001', hasProductIds: ['501', '502'], status: 'PACK' },
      },
      {
        kind: 'status-api' as const,
        payload: { orderId: '1001', hasProductIds: ['501'], status: 'SHIP' },
      },
      { kind: 'rto-api' as const, payload: { orderId: '1001', hasProductIds: ['501', '502'] } },
      { kind: 'out-for-delivery-api' as const, payload: { orderId: '1001', awb: 'FIXTURE-AWB' } },
      { kind: 'concurrency-sync' as const, payload: { storeId: '12', pending: -2, accepted: 2 } },
      { kind: 'concurrency-sync' as const, payload: { storeId: '12', pending: 0, accepted: -2 } },
      { kind: 'concurrency-sync' as const, payload: { storeId: '12', pending: 0, accepted: 0 } },
    ];
    const expected: unknown = JSON.parse(
      execFileSync('python3', ['tools/fulfillment/request-oracle.py'], {
        input: JSON.stringify({
          cases: cases.map((test) => ({ kind: test.kind, ...test.payload })),
        }),
        encoding: 'utf8',
      }),
    );
    const actual = cases.map((test) => {
      const request = effectRequest(delivery(test.kind, test.payload), config, options);
      if (!request) return null;
      const headers = { ...request.headers };
      delete headers['Idempotency-Key'];
      return { url: request.url.href, payload: request.payload, headers };
    });
    expect(actual).toEqual(expected);
  });
  it('preserves large integer HP identifiers without rounding warehouse conversion JSON', () => {
    const request = effectRequest(
      delivery('rejection-api', {
        orderId: '1001',
        hasProductIds: ['9007199254740993', '9223372036854775807'],
      }),
      config,
      options,
    );
    expect(JSON.stringify(request?.payload)).toBe(
      '{"order_id":1001,"has_product_ids":[9007199254740993,9223372036854775807]}',
    );
    expect(() =>
      effectRequest(
        delivery('rejection-api', { orderId: '1001', hasProductIds: ['9223372036854775808'] }),
        config,
        options,
      ),
    ).toThrow('out of range');
  });
  it('does not send without credentials and rejects non-TLS remote production dependencies', () => {
    expect(() =>
      effectRequest(
        delivery('concurrency-sync', { storeId: '12', pending: -2, accepted: 2 }),
        config,
        readFulfillmentOptions({}),
      ),
    ).toThrow('not configured');
    expect(() =>
      effectRequest(
        delivery('status-api', { orderId: '1001', hasProductIds: ['501'], status: 'PACK' }),
        { ...config, NODE_ENV: 'production' },
        { ...options, BACKEND_SYNC_API_BASE_URL: 'http://sync.example.test' },
      ),
    ).toThrow('HTTPS');
  });
});
