import { describe, expect, it } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import { fulfillmentEffects } from '../../src/modules/fulfillment/effects.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';
import { goldenStdout } from '../golden/load.js';

const options = {
  ...readFulfillmentOptions({}),
  BACKEND_SYNC_API_BASE_URL: 'https://sync.example.test',
  BACKEND_SYNC_REPO_API_KEY: 'fixture-sync-key',
  MJML_HOST: 'https://mailr.example.test/',
  PREORDER_URL: 'https://preorder.example.test/',
  PREORDER_INTERNAL_KEY: 'fixture-preorder-key',
  MAIN_API_V2_URL: 'https://api-v2.example.test/',
  API_V2_APP_ID: 'fixture-warehouse-id',
  API_V2_APP_KEY: 'fixture-warehouse-key',
};
const db: Databases = {
  get: () => {
    throw new Error('Unexpected DB call');
  },
  close: async () => {},
};
interface Recorded {
  url: string;
  payload: unknown;
  headers: Record<string, string>;
}
function recorder(status = 200, body = '{}') {
  const calls: Recorded[] = [],
    bodies: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    bodies.push(String(init?.body));
    calls.push({
      url: String(input),
      payload: JSON.parse(String(init?.body)) as unknown,
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, bodies, fetcher };
}
describe('external fulfillment request contracts', () => {
  it('matches the legacy status, RTO, mailr and signed-delta requests captured from the pinned source', async () => {
    // Same captured oracle input as before the outbox was removed; only the caller changed.
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
      goldenStdout(
        'fulfillment',
        'integrations',
        JSON.stringify({
          cases: cases.map((test) => ({ kind: test.kind, ...test.payload })),
        }),
      ),
    );
    const actual: (Recorded | null)[] = [];
    for (const test of cases) {
      const { calls, fetcher } = recorder(),
        effects = fulfillmentEffects(db, options, { fetch: fetcher });
      const p = test.payload as unknown as Record<string, string | number | string[]>;
      if (test.kind === 'status-api')
        await effects.callStatusApi(
          String(p.orderId),
          p.hasProductIds as string[],
          String(p.status),
          true,
        );
      if (test.kind === 'rto-api')
        await effects.vinculumRto(String(p.orderId), p.hasProductIds as string[]);
      if (test.kind === 'out-for-delivery-api')
        await effects.outForDelivery(String(p.orderId), String(p.awb));
      if (test.kind === 'concurrency-sync') {
        effects.concurrencySync(String(p.storeId), {
          pending: Number(p.pending),
          accepted: Number(p.accepted),
        });
        await effects.idle();
      }
      expect(calls.length).toBeLessThanOrEqual(1);
      const call = calls[0];
      actual.push(call ? { ...call, headers: { ...call.headers } } : null);
    }
    expect(actual).toEqual(expected);
  });
  it('sends warehouse conversion to MAIN_API_V2_URL with exact 64-bit integers and legacy headers', async () => {
    const { calls, bodies, fetcher } = recorder(500),
      effects = fulfillmentEffects(db, options, { fetch: fetcher });
    await effects.rejectionApi('1001', ['9007199254740993', '9223372036854775807'], {
      kind: 'timed-out',
      storeId: '12',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api-v2.example.test/express-to-warehouse-order');
    expect(bodies[0]).toBe(
      '{"order_id":1001,"has_product_ids":[9007199254740993,9223372036854775807]}',
    );
    expect(calls[0]!.headers).toEqual({
      'Content-Type': 'application/json',
      Ar_app_id: 'fixture-warehouse-id',
      Ar_app_key: 'fixture-warehouse-key',
    });
  });
  it('skips unconfigured services and never throws on a failed call, as legacy only logs', async () => {
    const { calls, fetcher } = recorder(),
      events: string[] = [],
      effects = fulfillmentEffects(db, readFulfillmentOptions({}), {
        fetch: fetcher,
        log: (_level, event) => events.push(event.eventId),
      });
    effects.concurrencySync('12', { pending: -1, accepted: 1 });
    await effects.rejectionApi('1', ['2'], { kind: 'timed-out', storeId: '12' });
    await effects.outForDelivery('1', 'AWB');
    await effects.vinculumRto('1', ['2']);
    expect(await effects.callStatusApi('1', ['2'], 'PACK', true)).toBe('skipped-unconfigured');
    expect(calls).toHaveLength(0);
    const failing = fulfillmentEffects(db, options, {
      fetch: async () => {
        throw new Error('network down');
      },
    });
    await expect(failing.outForDelivery('1', 'AWB')).resolves.toBeUndefined();
    await expect(failing.vinculumRto('1', ['2'])).resolves.toBeUndefined();
    expect(events).toContain('fulfillment.concurrency-sync.skipped');
  });
  it('keeps routine alerts out of the common channel and copies others only when enabled', async () => {
    const { calls, fetcher } = recorder(),
      effects = fulfillmentEffects(
        db,
        {
          ...options,
          SLACK_URL: 'https://hooks.slack.com/services/common',
          COMMON_GROUP_ALERT_ON: true,
        },
        { fetch: fetcher },
      );
    await effects.slack('routine', { slackUrl: null, sendToCommon: false });
    await effects.slack('routine', { slackUrl: '', sendToCommon: false });
    expect(calls).toHaveLength(0);
    await effects.slack('store', {
      slackUrl: 'https://hooks.slack.com/services/store',
      sendToCommon: false,
    });
    await effects.slack('abnormal', { slackUrl: 'https://hooks.slack.com/services/store' });
    await effects.slack('blocked', { slackUrl: 'https://attacker.example/hook' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://hooks.slack.com/services/store',
      'https://hooks.slack.com/services/store',
      'https://hooks.slack.com/services/common',
      // A refused store channel never stops the common copy (`helpers/helpers.py:1124-1130`).
      'https://hooks.slack.com/services/common',
    ]);
  });
});
