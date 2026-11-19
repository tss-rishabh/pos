import { describe, expect, it, vi } from 'vitest';
import { syncRepoStatusApi } from '../../src/modules/legacy-order-status/transport.js';
import {
  syncRepoBaseUrl,
  readWholeOrderStatusOptions,
} from '../../src/modules/legacy-order-status/options.js';
import {
  registerJobHandlers,
  enqueuePushVincOrderForAll,
} from '../../src/modules/legacy-order-status/jobs.js';
import type { JobHandler, JobName, JobProducer } from '../../src/jobs/contract.js';
import type { Databases } from '../../src/db/pools.js';
import { config } from './fixtures.js';

describe('Helpers.call_status_api port', () => {
  it('posts the legacy body, headers and path, and the hyperlocal path for express lines', async () => {
    const fetcher = vi.fn(async () => new Response('{}'));
    const call = syncRepoStatusApi(
      {
        BACKEND_SYNC_API_BASE_URL: 'https://sync.synthetic.invalid',
        BACKEND_SYNC_REPO_API_KEY: 'k',
      },
      fetcher,
    );
    expect(await call(12n, [3n, '4'], 'SHIP')).toBe('sent');
    expect(await call('12', ['3'], 'PACK', true)).toBe('sent');
    const [first, second] = fetcher.mock.calls as unknown as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(first[0]).toBe('https://sync.synthetic.invalid/store-order/status');
    expect(first[1].headers).toEqual({ 'Content-Type': 'application/json', 'x-api-key': 'k' });
    expect(JSON.parse(String(first[1].body))).toEqual({
      orderId: '12',
      has_product_ids: ['3', '4'],
      platform: 'SHIP',
    });
    expect(second[0]).toBe('https://sync.synthetic.invalid/order/status');
  });
  it('never throws and reports failures', async () => {
    const outcomes: string[] = [];
    const call = syncRepoStatusApi(
      { BACKEND_SYNC_API_BASE_URL: 'https://sync.synthetic.invalid' },
      async () => {
        throw new Error('down');
      },
      (outcome) => outcomes.push(outcome),
    );
    await expect(call('1', [], 'PACK')).resolves.toBe('failed');
    expect(outcomes).toEqual(['failed']);
  });
  it('refuses credentials or plain HTTP to a remote host in production', () => {
    const production = { NODE_ENV: 'production' as const };
    expect(
      syncRepoBaseUrl(
        production,
        readWholeOrderStatusOptions({ BACKEND_SYNC_API_BASE_URL: 'http://sync.example/' }),
      ),
    ).toBeUndefined();
    expect(
      syncRepoBaseUrl(
        production,
        readWholeOrderStatusOptions({ BACKEND_SYNC_API_BASE_URL: 'https://u:p@sync.example/' }),
      ),
    ).toBeUndefined();
    expect(
      syncRepoBaseUrl(
        production,
        readWholeOrderStatusOptions({ BACKEND_SYNC_API_BASE_URL: 'https://sync.example/' }),
      ),
    ).toBe('https://sync.example');
  });
});

describe('C12 core.tasks.push_vinc_order_for_all', () => {
  it('enqueues on queue core and the handler sends PACK for every order line', async () => {
    const enqueue = vi.fn<JobProducer['enqueue']>(async (name, _args, options) => ({
      jobId: 'j',
      name,
      queue: options.queue,
      dueAt: 0,
    }));
    await enqueuePushVincOrderForAll({ enqueue }, '77');
    expect(enqueue).toHaveBeenCalledWith(
      'core.tasks.push_vinc_order_for_all',
      { order_id: '77' },
      { queue: 'core' },
    );
    const handlers = new Map<JobName, JobHandler>();
    const rows = [{ id: 5n }, { id: 6n }];
    const db = {
      get: () => ({ select: () => ({ from: () => ({ where: async () => rows }) }) }),
    } as unknown as Databases;
    const callStatusApi = vi.fn(async () => 'sent' as const);
    registerJobHandlers(
      { register: (name, handler) => handlers.set(name, handler) },
      { config, db, callStatusApi },
    );
    await handlers.get('core.tasks.push_vinc_order_for_all')!(
      { order_id: '77' },
      {
        jobId: 'j',
        name: 'core.tasks.push_vinc_order_for_all',
        requestId: null,
        userId: null,
        signal: new AbortController().signal,
      },
    );
    expect(callStatusApi).toHaveBeenCalledWith('77', ['5', '6'], 'PACK', false);
  });
});
