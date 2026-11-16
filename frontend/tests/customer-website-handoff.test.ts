import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueWebsiteHandoff, websiteHandoffUrl } from '../src/pages/customer-website-handoff/api';
import { setRequestOperator } from '../src/api/client';
const checkoutId = '4918d168-c62e-4ed7-b8ae-89b0a5e70012',
  operationId = '4918d168-c62e-4ed7-b8ae-89b0a5e70019';
const url = 'https://website.fixture.test/pos/secure-login#' + 'a'.repeat(43);
afterEach(() => {
  vi.unstubAllGlobals();
  setRequestOperator(null);
});
describe('website handoff client', () => {
  it('only accepts the exact HTTPS receiver and opaque fragment, without query credentials', () => {
    expect(websiteHandoffUrl(url, 'https://website.fixture.test')).toBe(url);
    for (const value of [
      url.replace('https:', 'http:'),
      url.replace('website.fixture.test', 'other.fixture.test'),
      url.replace('/pos/secure-login', '/other'),
      url.replace('#', '?token=x#'),
      url.replace('https://', 'https://u:p@'),
      url.replace('#', ''),
    ])
      expect(() => websiteHandoffUrl(value, 'https://website.fixture.test')).toThrow();
  });
  it('retries the same immutable metadata intent and binds transport to the captured operator', async () => {
    setRequestOperator('1');
    const bodies: string[] = [],
      headers: Headers[] = [];
    vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
      bodies.push(String(init.body));
      headers.push(new Headers(init.headers));
      if (bodies.length === 1) throw new Error('Synthetic lost issue reply');
      return new Response(
        JSON.stringify({
          contract: 'pos-customer-website-handoff-v1',
          id: operationId,
          operationId,
          checkoutId,
          checkoutVersion: 2,
          url,
          serverNow: 1700000000000,
          expiresAt: 1700000060000,
        }),
      );
    });
    const signal = new AbortController().signal;
    await expect(
      issueWebsiteHandoff('1', '1', checkoutId, 2, operationId, signal),
    ).rejects.toThrow();
    const grant = await issueWebsiteHandoff('1', '1', checkoutId, 2, operationId, signal);
    expect(bodies[1]).toBe(bodies[0]);
    expect(headers.every((value) => value.get('X-Operator-ID') === '1')).toBe(true);
    expect(grant.operationId).toBe(operationId);
    setRequestOperator('2');
    await expect(
      issueWebsiteHandoff('1', '1', checkoutId, 2, operationId, signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(bodies).toHaveLength(2);
  });
});
