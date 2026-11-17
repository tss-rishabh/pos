import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readEcommerceSynchronizationOptions } from '../../../src/modules/administration/ecommerce-sync/options.js';
import {
  createEcommerceFullSyncAdapter,
  fullSyncResponseSignature,
} from '../../../src/modules/administration/ecommerce-sync/http.js';
import {
  fullSyncBody,
  fullSyncContract,
  fullSyncHash,
  type FullSyncCommand,
} from '../../../src/modules/administration/ecommerce-sync/domain.js';
const secret = 'fixture-purpose-secret-'.repeat(3),
  command: FullSyncCommand = {
    operationId: '10000000-0000-4000-8000-000000000001',
    storeId: '9007199254740993',
    actorId: '900001',
    requestId: 'fixture-request',
  };
const options = readEcommerceSynchronizationOptions({
  ECOMMERCE_FULL_SYNC_CONTRACT: fullSyncContract,
  ECOMMERCE_FULL_SYNC_URL: 'https://fixture.invalid/private/ecommerce-full-sync',
  ECOMMERCE_FULL_SYNC_SECRET: secret,
});
const receipt = () => ({
  contract: fullSyncContract,
  operationId: command.operationId,
  requestHash: fullSyncHash(command),
  status: 'succeeded',
  proof: { mongoWrites: 10, redisWrites: 10, cdnBatches: 1, catalogDigest: 'a'.repeat(64) },
  errorCode: null,
});
function response(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Ecom-Signature': fullSyncResponseSignature(secret, command.operationId, body),
    },
  });
}
describe('purpose-specific full ecommerce sync transport', () => {
  it('is default disabled and accepts only explicit supported private HTTPS configuration', () => {
    expect(createEcommerceFullSyncAdapter(readEcommerceSynchronizationOptions({}))).toBeUndefined();
    for (const url of [
      'http://fixture.invalid/full-sync',
      'https://user:pass@fixture.invalid/full-sync',
      'https://fixture.invalid/full-sync?secret=bad',
      'https://fixture.invalid/full-sync#fragment',
    ])
      expect(() =>
        createEcommerceFullSyncAdapter({ ...options, ECOMMERCE_FULL_SYNC_URL: url }),
      ).toThrow();
    expect(() =>
      readEcommerceSynchronizationOptions({ ECOMMERCE_FULL_SYNC_CONTRACT: 'unreviewed' }),
    ).toThrow();
  });
  it('signs exact body/method/path/timestamp with a separate key and never puts credentials or contact data in URLs', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [],
      adapter = createEcommerceFullSyncAdapter(
        options,
        async (url, init) => {
          calls.push({ url: String(url), init });
          return response(receipt());
        },
        () => 1700000000000,
      )!;
    expect((await adapter.submit(command)).status).toBe('succeeded');
    await adapter.read(command);
    expect(calls.map((call) => call.init?.method)).toEqual(['POST', 'GET']);
    expect(calls[0]?.init?.body).toBe(fullSyncBody(command));
    for (const call of calls) {
      const url = new URL(call.url),
        headers = new Headers(call.init?.headers),
        body = typeof call.init?.body === 'string' ? call.init.body : '';
      expect(url.search).toBe('');
      expect(call.url).not.toContain(secret);
      expect(call.init?.redirect).toBe('error');
      expect(headers.get('idempotency-key')).toBe(command.operationId);
      expect(headers.get('x-ecom-signature')).toBe(
        createHmac('sha256', secret)
          .update(
            `${fullSyncContract}\n1700000000\n${call.init?.method}\n${url.pathname}\n${createHash('sha256').update(body).digest('hex')}`,
          )
          .digest('hex'),
      );
    }
  });
  it('does not equate legacy started acknowledgement, unsigned replies or mismatched proof with completion', async () => {
    const cases = [
      () =>
        new Response(JSON.stringify({ success: true, message: 'Sync Product Started' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      () => response({ ...receipt(), operationId: '10000000-0000-4000-8000-000000000002' }),
      () => response({ ...receipt(), requestHash: 'b'.repeat(64) }),
      () => response({ ...receipt(), proof: null }),
      () => response({ ...receipt(), status: 'running' }),
      () => response(receipt(), 301),
    ];
    for (const fake of cases) {
      const adapter = createEcommerceFullSyncAdapter(options, async () => fake())!;
      await expect(adapter.submit(command)).rejects.toMatchObject({
        code: 'ECOMMERCE_FULL_SYNC_UNAVAILABLE',
      });
    }
  });
  it('requires authenticated exact404 proof for safe original-UUID recovery', async () => {
    const missing = {
        contract: fullSyncContract,
        operationId: command.operationId,
        error: 'ECOMMERCE_FULL_SYNC_NOT_FOUND',
      },
      adapter = createEcommerceFullSyncAdapter(options, async () => response(missing, 404))!;
    expect(await adapter.read(command)).toBeNull();
    await expect(adapter.submit(command)).rejects.toMatchObject({
      code: 'ECOMMERCE_FULL_SYNC_UNAVAILABLE',
    });
    const unsigned = createEcommerceFullSyncAdapter(
      options,
      async () =>
        new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }),
    )!;
    await expect(unsigned.read(command)).rejects.toMatchObject({
      code: 'ECOMMERCE_FULL_SYNC_UNAVAILABLE',
    });
  });
  it('bounds response bytes and validates even GET IDs before dispatch', async () => {
    let calls = 0;
    const adapter = createEcommerceFullSyncAdapter(options, async () => {
      calls++;
      return new Response('x'.repeat(17000), { headers: { 'Content-Type': 'application/json' } });
    })!;
    await expect(adapter.submit(command)).rejects.toMatchObject({
      code: 'ECOMMERCE_FULL_SYNC_UNAVAILABLE',
    });
    await expect(adapter.read({ ...command, operationId: '../../wrong' })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
