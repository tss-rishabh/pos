import { describe, expect, it, vi } from 'vitest';
import { goldenSourceStatusOracle } from './source-helper.js';
import { syncRepoStatusApi } from '../../src/modules/legacy-order-status/transport.js';
import { queuedMessage } from '../../src/modules/legacy-order-status/domain.js';
import { snapshot, lineIds } from './fixtures.js';

/** Captures what the rewrite sends for one legacy callback/task case. */
async function rewriteRequests(
  platform: string,
  base: string | undefined,
  response: () => Promise<Response>,
) {
  const calls: { path: string; body: unknown; headerNames: string[] }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname.replace(/^\/api/, ''),
      body: JSON.parse(String(init?.body)) as unknown,
      headerNames: Object.keys(init?.headers ?? {}),
    });
    return response();
  });
  await syncRepoStatusApi(
    { BACKEND_SYNC_API_BASE_URL: base, BACKEND_SYNC_REPO_API_KEY: 'synthetic-private-sync-key' },
    fetcher,
  )(snapshot.orderId, lineIds, platform, false);
  return calls;
}
const base = 'https://sync.synthetic.invalid/api/';

describe('legacy whole-order callback/task contract (golden capture of the pinned source)', () => {
  const orderId = snapshot.orderId;
  it('sends every has_products id once per platform, and the task always uses PACK', async () => {
    const cases = [
        ...(['PACK', 'SHIP', 'DELIVER'] as const).map((platform) => ({ orderId, platform })),
        { orderId, kind: 'task' },
      ],
      golden = goldenSourceStatusOracle('source', {
        lines: snapshot.lines.map((row) => ({ ...row, orderId })),
        cases,
      });
    for (let i = 0; i < golden.length; i++) {
      const value = cases[i]!,
        platform = 'platform' in value ? value.platform : 'PACK',
        actual = await rewriteRequests(platform, base, async () => new Response('{}'));
      expect(golden[i]!.requests).toHaveLength(1);
      expect(actual).toEqual(
        golden[i]!.requests.map(({ path, body, headerNames }) => ({ path, body, headerNames })),
      );
      if (golden[i]!.callback) expect(golden[i]!.callback!.message).toBe(queuedMessage);
    }
  });
  it('acknowledges the same message on missing config, HTTP failure and timeout', async () => {
    const golden = goldenSourceStatusOracle('source', {
      lines: snapshot.lines.map((row) => ({ ...row, orderId })),
      cases: [
        { orderId, platform: 'PACK', missingEndpoint: true },
        { orderId, platform: 'PACK', httpStatus: 400 },
        { orderId, platform: 'PACK', transportError: true },
      ],
    });
    expect(golden.map((row) => row.callback)).toEqual(
      Array.from({ length: 3 }, () => ({ status: 200, message: queuedMessage })),
    );
    expect(golden[0]!.requests).toEqual([]);
    expect(await rewriteRequests('PACK', undefined, async () => new Response('{}'))).toEqual([]);
    expect(
      await rewriteRequests('PACK', base, async () => new Response('bad', { status: 400 })),
    ).toHaveLength(1);
    await expect(
      rewriteRequests('PACK', base, async () => {
        throw new TypeError('network');
      }),
    ).resolves.toHaveLength(1);
  });
});
