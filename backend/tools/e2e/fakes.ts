import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Loopback fake HTTP endpoints for the e2e stack's sandbox adapters. Each adapter gets its own
 * path prefix; the server records method, adapter and path only (never bodies, headers or
 * query values) so a run can be inspected at `GET /__requests`.
 *
 * Only adapters whose configuration accepts plain-http loopback outside production point here
 * (API-v2, payment terminals, product sync). OTP SMS/email and login Slack alerts require HTTPS
 * endpoints, so the stack selects the existing in-process sandbox transport for them with
 * `LOGIN_OTP_DELIVERY=sandbox` instead.
 */
export const fakeAdapters = [
  'api-v2',
  'payments',
  'sms',
  'email',
  'slack',
  'product-sync',
] as const;
export type FakeAdapter = (typeof fakeAdapters)[number];

export interface RecordedRequest {
  adapter: FakeAdapter;
  method: string;
  path: string;
}

function respond(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

export async function startFakeAdapters(port = 0) {
  const requests: RecordedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    // Drain and discard the body: fakes never retain request payloads.
    request.resume();
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1'),
        [, prefix = '', ...rest] = url.pathname.split('/');
      if (url.pathname === '/__requests' && request.method === 'GET')
        return respond(response, 200, { requests });
      if (url.pathname === '/health') return respond(response, 200, { status: 'ok' });
      const adapter = fakeAdapters.find((name) => name === prefix);
      if (!adapter) return respond(response, 404, { status: 'error', message: 'Unknown fake.' });
      requests.push({ adapter, method: request.method ?? 'GET', path: '/' + rest.join('/') });
      // A generic success envelope; specs that need specific provider replies route-mock them.
      return respond(response, 200, { status: 'success', success: true, data: {} });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    url: (adapter: FakeAdapter) => `${origin}/${adapter}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
