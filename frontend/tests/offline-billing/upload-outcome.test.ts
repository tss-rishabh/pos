import { describe, expect, it } from 'vitest';
import {
  NetworkUnavailableError,
  RequestNotSentError,
  preSendNetworkError,
  serverApi,
  type HttpClient,
  type HttpResponse,
} from '../../electron/offline/server';
import type { OfflineSaleUpload } from '../../src/offline/billing/sync-contract';

const sale: OfflineSaleUpload = {
  saleId: '0b9f1a2c-3d4e-4f50-8a61-7b8c9d0e1f2a',
  provisionalRef: 'OFF-12-3-ABCDEF01-1',
  deviceId: 'abcdef0123456789abcdef0123456789',
  billedBy: '77',
  billedAt: Date.UTC(2026, 10, 19, 9),
  lines: [{ productId: '1001', quantity: 2, unitPrice: '499.50' }],
  salespersonId: '4401',
  payable: '999.00',
  tender: { mode: 'cash', received: '1000.00' },
  resolution: null,
};
const upload = (reply: () => Promise<HttpResponse>) => {
  const http: HttpClient = { request: reply };
  return serverApi(http).upload('trace', '77', '12', '3', sale);
};
const respond = (status: number, body: unknown) => async () => ({ status, body });
const error = (code: string, message = 'Refused.') => ({ error: { code, message } });

describe('offline sale upload outcome', () => {
  it('retries only a request that provably never left the device', async () => {
    await expect(
      upload(async () => {
        throw new RequestNotSentError();
      }),
    ).resolves.toEqual({ kind: 'retry', code: 'NETWORK_UNAVAILABLE' });
  });

  it.each([
    [
      'a transport failure after sending (reset, timeout, abort)',
      async () => {
        throw new NetworkUnavailableError();
      },
    ],
    ['a 5xx without a code', respond(502, '<html>Bad gateway</html>')],
    ['a 503 from the store service', respond(503, error('OFFLINE_SYNC_UNAVAILABLE'))],
    ['a 500', respond(500, error('INTERNAL_ERROR'))],
    ['a 408', respond(408, null)],
    ['a 429', respond(429, error('RATE_LIMITED'))],
    ['a success reply that does not parse', respond(201, { orderId: 'x' })],
    [
      'a success reply for another reference',
      respond(201, {
        status: 'created',
        orderId: '5001',
        invoiceNumber: null,
        provisionalRef: 'OFF-12-3-ABCDEF01-2',
      }),
    ],
    ['an unknown conflict suffix', respond(409, error('OFFLINE_CONFLICT_SOMETHING_NEW'))],
  ] as const)('treats %s as an unknown outcome for the manager', async (_name, reply) => {
    await expect(upload(reply)).resolves.toMatchObject({
      kind: 'conflict',
      code: 'OUTCOME_UNKNOWN',
    });
  });

  it('keeps the server reason on a refusal it cannot place, still as an unknown outcome', async () => {
    const outcome = await upload(
      respond(403, error('MANAGER_REQUIRED', 'A store manager must sync a resolved offline sale.')),
    );
    expect(outcome).toMatchObject({ kind: 'conflict', code: 'OUTCOME_UNKNOWN' });
    expect(outcome.kind === 'conflict' && outcome.message).toMatch(
      /^A store manager must sync a resolved offline sale\. The store service may already/,
    );
  });

  it.each(['OFFLINE_SYNC_IN_PROGRESS', 'CHECK_IN_REQUIRED', 'OPERATOR_CHANGED'])(
    'retries the explicit pre-dispatch refusal %s',
    async (code) => {
      await expect(
        upload(respond(code === 'OFFLINE_SYNC_IN_PROGRESS' ? 503 : 409, error(code))),
      ).resolves.toEqual({ kind: 'retry', code });
    },
  );

  it('maps the session refusal, explicit conflicts and a valid success', async () => {
    await expect(upload(respond(401, error('AUTH_REQUIRED')))).resolves.toEqual({
      kind: 'unauthorized',
    });
    await expect(
      upload(respond(409, error('OFFLINE_CONFLICT_PRICE_CHANGED', 'Price changed.'))),
    ).resolves.toEqual({ kind: 'conflict', code: 'PRICE_CHANGED', message: 'Price changed.' });
    await expect(
      upload(
        respond(201, {
          status: 'created',
          orderId: '5001',
          invoiceNumber: 'INV1',
          provisionalRef: sale.provisionalRef,
        }),
      ),
    ).resolves.toEqual({ kind: 'synced', orderId: '5001', invoiceNumber: 'INV1' });
  });
});

describe('pre-send network errors', () => {
  it.each([
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_ADDRESS_UNREACHABLE',
    'net::ERR_CERT_AUTHORITY_INVALID',
  ])('%s proves the request was not sent', (message) => {
    expect(preSendNetworkError(message)).toBe(true);
  });
  it.each([
    'net::ERR_CONNECTION_RESET',
    'net::ERR_EMPTY_RESPONSE',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_TIMED_OUT',
    'net::ERR_ABORTED',
    'net::ERR_NETWORK_CHANGED',
    'socket hang up',
  ])('%s may have reached the server', (message) => {
    expect(preSendNetworkError(message)).toBe(false);
  });
});
