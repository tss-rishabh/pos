import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueWebsiteHandoff, websiteHandoffUrl } from '../src/pages/customer-website-handoff/api';
import { setRequestOperator } from '../src/api/client';
const checkoutId = '4918d168-c62e-4ed7-b8ae-89b0a5e70012';
const url =
  'https://website.fixture.test/pos/login/?token=a.b.c&api_key=k&pos_store_id=1&pos_user_id=88';
afterEach(() => {
  vi.unstubAllGlobals();
  setRequestOperator(null);
});
describe('website order client', () => {
  it('only opens the legacy HTTPS /pos/login/ page', () => {
    expect(websiteHandoffUrl(url)).toBe(url);
    for (const value of [
      url.replace('https:', 'http:'),
      url.replace('/pos/login/', '/other'),
      url.replace('https://', 'https://u:p@'),
    ])
      expect(() => websiteHandoffUrl(value)).toThrow();
  });
  it('binds the request to the captured operator', async () => {
    setRequestOperator('1');
    const headers: Headers[] = [];
    vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      return new Response(JSON.stringify({ webUrl: url, sessionMinutes: 10 }));
    });
    const signal = new AbortController().signal;
    const result = await issueWebsiteHandoff('1', '1', checkoutId, signal);
    expect(result).toEqual({ webUrl: url, sessionMinutes: 10 });
    expect(headers[0]!.get('X-Operator-ID')).toBe('1');
    setRequestOperator('2');
    await expect(issueWebsiteHandoff('1', '1', checkoutId, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
