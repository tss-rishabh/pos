import { describe, expect, it } from 'vitest';
import {
  createProductSyncAdapter,
  productSynchronizationBody,
  productSynchronizer,
} from '../../src/modules/administration/product-sync.js';
import { readAdministrationWorkerOptions } from '../../src/modules/administration/worker-options.js';
import { goldenStdout } from '../golden/load.js';

const config = {
  NODE_ENV: 'test' as const,
  TSS_API_MIGRATION_V2: true,
  TSS_API_BASE_URL: undefined,
};
const context = { operatorId: '4', storeId: '1', requestId: 'fixture-request-id' };
describe('inventory synchronization HTTP boundary', () => {
  it('is disabled until endpoint and replay safety are explicitly configured', () => {
    expect(readAdministrationWorkerOptions({}).PRODUCT_SYNC_REPLAY_SAFE).toBe(false);
    expect(createProductSyncAdapter(config, readAdministrationWorkerOptions({}))).toBeUndefined();
    expect(
      createProductSyncAdapter(
        config,
        readAdministrationWorkerOptions({
          PRODUCT_SYNC_BASE_URL: 'https://sync.example.test/',
          PRODUCT_SYNC_URI: 'sync/products',
        }),
      ),
    ).toBeUndefined();
  });
  it('lets inline callers skip the replay gate and logs, never throws, a refused sync', async () => {
    const options = readAdministrationWorkerOptions({
        PRODUCT_SYNC_BASE_URL: 'https://sync.example.test/',
        PRODUCT_SYNC_URI: 'sync/products',
      }),
      bodies: string[] = [];
    let status = 200;
    const adapter = createProductSyncAdapter(
      config,
      options,
      async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response(null, { status });
      },
      { requireReplaySafe: false },
    );
    expect(adapter).toBeDefined();
    const logs: unknown[] = [];
    const sync = productSynchronizer(adapter, (_level, event) => logs.push(event));
    expect(await sync(['11', '-3', '11'], { operatorId: '4', storeId: '1' })).toBe(true);
    expect(bodies).toEqual(['{"product_id_list":[11,-3,11]}']);
    status = 500;
    expect(await sync(['11'], { operatorId: '4' })).toBe(false);
    expect(logs).toEqual([
      expect.objectContaining({
        eventId: 'administration.product-sync.failed',
        errorCode: 'PRODUCT_SYNC_REJECTED',
        userId: '4',
      }),
    ]);
    expect(
      await productSynchronizer(undefined, (_level, event) => logs.push(event))(['1'], {
        operatorId: '4',
      }),
    ).toBe(false);
    expect(logs).toHaveLength(2);
  });
  it('matches source sync_pos_product URL and integer JSON contract without bigint precision loss', async () => {
    const cases = [true, false].flatMap((migration) =>
      [false, true].map((troubleshoot) => ({
        migration,
        troubleshoot,
        mainBase: 'https://main.example.test/api/',
        legacyBase: 'https://legacy.example.test/api/',
        uri: 'sync/products',
        productIds: ['1', '9007199254740993', '18446744073709551615'],
      })),
    );
    const expected: unknown = JSON.parse(
      goldenStdout(
        'administration',
        'worker',
        JSON.stringify({ operation: 'product-sync', cases }),
      ),
    ) as unknown;
    const actual: { url: string; body: string; headers: Record<string, string> }[] = [];
    for (const value of cases) {
      const options = readAdministrationWorkerOptions({
        MAIN_API_V2_URL: value.mainBase,
        API_V2_URL: value.legacyBase,
        PRODUCT_SYNC_URI: value.uri,
        PRODUCT_SYNC_REPLAY_SAFE: 'true',
      });
      const fetcher: typeof fetch = async (input, init) => {
        actual.push({
          url: String(input),
          body: typeof init?.body === 'string' ? init.body : '',
          headers: { 'Content-Type': new Headers(init?.headers).get('content-type') || '' },
        });
        expect(new Headers(init?.headers).get('idempotency-key')).toBe('fixture-effect-id');
        expect(new Headers(init?.headers).get('x-request-id')).toBe(context.requestId);
        expect(init?.redirect).toBe('error');
        return new Response(null, { status: 200 });
      };
      const adapter = createProductSyncAdapter(
        { ...config, TSS_API_MIGRATION_V2: value.migration },
        options,
        fetcher,
      )!;
      await adapter('fixture-effect-id', value.productIds, {
        operatorId: context.operatorId,
        requestId: context.requestId,
        ...(value.troubleshoot ? {} : { storeId: context.storeId }),
        troubleshoot: value.troubleshoot,
      });
    }
    expect(actual).toEqual(expected);
    expect(productSynchronizationBody(['1'], true)).toBe(
      '{"product_id_list":[1],"is_troubleshoot":true}',
    );
    expect(() => productSynchronizationBody(['1,2'])).toThrow();
  });
  it('rejects remote plaintext, URL credentials, and origin confusion', () => {
    const options = (base: string) =>
      readAdministrationWorkerOptions({
        PRODUCT_SYNC_BASE_URL: base,
        PRODUCT_SYNC_URI: 'sync/products',
        PRODUCT_SYNC_REPLAY_SAFE: 'true',
      });
    for (const base of [
      'http://sync.example.test/',
      'https://user:private-canary@sync.example.test/',
      'https://sync.example.test/?token=private-canary',
    ])
      expect(() => createProductSyncAdapter(config, options(base))).toThrow(
        'approved product synchronization endpoint',
      );
    expect(() =>
      createProductSyncAdapter({ ...config, NODE_ENV: 'production' }, options('http://127.0.0.1/')),
    ).toThrow();
  });
  it('uses bounded abortable HTTP calls and exposes only stable failure codes', async () => {
    const options = readAdministrationWorkerOptions({
      PRODUCT_SYNC_BASE_URL: 'https://sync.example.test/',
      PRODUCT_SYNC_URI: 'sync/products',
      PRODUCT_SYNC_REPLAY_SAFE: 'true',
      PRODUCT_SYNC_HTTP_TIMEOUT_MS: '100',
    });
    const rejected = createProductSyncAdapter(
      config,
      options,
      async () => new Response('private-canary@example.test', { status: 503 }),
    )!;
    await expect(rejected('fixture-effect-id', ['1'], context)).rejects.toMatchObject({
      code: 'PRODUCT_SYNC_REJECTED',
      message: 'Product synchronization was not acknowledged.',
    });
    const fetcher: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error('private-canary'));
        else
          init?.signal?.addEventListener('abort', () => reject(new Error('private-canary')), {
            once: true,
          });
      });
    const aborted = createProductSyncAdapter(config, options, fetcher)!;
    const signal = new AbortController();
    signal.abort();
    await expect(aborted('fixture-effect-id', ['1'], context, signal.signal)).rejects.toMatchObject(
      { code: 'PRODUCT_SYNC_UNAVAILABLE', message: 'Product synchronization is unavailable.' },
    );
    await expect(aborted('fixture-effect-id', ['1'], context)).rejects.toMatchObject({
      code: 'PRODUCT_SYNC_UNAVAILABLE',
    });
  });
});
