import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { customerBriefingGateway } from '../src/modules/customer-insights/briefing-gateway.js';
import { readCustomerBriefingOptions } from '../src/modules/customer-insights/briefing-options.js';

const config = readConfig({
  NODE_ENV: 'test',
  MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
  SESSION_SECRET: 'customer-insight-fixture-session-key-'.repeat(2),
});
const options = readCustomerBriefingOptions({
  CUSTOMER_INSIGHT_URL: 'http://127.0.0.1:9/private/insights',
  CUSTOMER_INSIGHT_API_KEY: 'private-insight-fixture-key',
});
// Legacy AjaxCustomerInsightView sends no contract header and requires none back.
const headers = {};
describe('source contact-first private customer insight gateway', () => {
  it('preserves contacts/store and never sends a conflicting POS ID alongside contact lookup', async () => {
    const requests: { url: URL; init?: RequestInit }[] = [];
    const gateway = customerBriefingGateway(config, options, async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      return Response.json(
        {
          success: true,
          data: { user_id: 'different-service-id', customer: { name: 'Fixture', is_exclusive: 1 } },
        },
        { headers },
      );
    });
    for (const identity of [
      { id: '9007199254740993', email: 'guest@example.test', telephone: '9876543210' },
      { id: '9007199254740993', email: '', telephone: '9876543210' },
      { id: '9007199254740993', email: '', telephone: '' },
    ])
      expect((await gateway.read(identity, '1')).customer?.is_exclusive).toBe(true);
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      email: 'guest@example.test',
      telephone: '9876543210',
      store_id: '1',
    });
    expect(Object.fromEntries(requests[1]!.url.searchParams)).toEqual({
      telephone: '9876543210',
      store_id: '1',
    });
    expect(Object.fromEntries(requests[2]!.url.searchParams)).toEqual({
      user_id: '9007199254740993',
      store_id: '1',
    });
    for (const request of requests) {
      expect(request.init?.method).toBe('GET');
      expect(request.init?.redirect).toBe('error');
      expect(request.init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(request.init?.headers).get('X-API-Key')).toBe(
        options.CUSTOMER_INSIGHT_API_KEY,
      );
    }
  });
  it('keeps the unconfigured/store/transport gates before network dispatch', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({}, { headers });
    };
    for (const candidate of [
      readCustomerBriefingOptions({}),
      { ...options, CUSTOMER_INSIGHT_URL: 'http://outside.example.test/private' },
      { ...options, CUSTOMER_INSIGHT_URL: 'https://user:password@example.test/private' },
      { ...options, CUSTOMER_INSIGHT_URL: 'https://example.test/private?customer=unbound' },
      { ...options, CUSTOMER_INSIGHT_STORE_IDS: ['2'] },
    ])
      await expect(
        customerBriefingGateway(config, candidate, fetcher).read(
          { id: '777', email: '', telephone: '' },
          '1',
        ),
      ).rejects.toMatchObject({ status: expect.any(Number) });
    expect(calls).toBe(0);
  });
  it('rejects source explicit-false envelopes, non-200 and unreadable/oversized bodies without leaking error data', async () => {
    const responses = [
      Response.json({ success: false, error: 'secret email@example.test' }, { headers }),
      Response.json({ detail: 'secret SQL' }, { status: 403, headers }),
      new Response('not-json', { headers }),
      Response.json({ customer: { name: 'x'.repeat(300_000) } }, { headers }),
      Response.json(
        { success: true, data: { action_points: [{ kind: 'rec', count: -1 }] } },
        { headers },
      ),
    ];
    for (const response of responses) {
      const result = customerBriefingGateway(config, options, async () => response).read(
        { id: '777', email: '', telephone: '' },
        '1',
      );
      await expect(result).rejects.toMatchObject({
        code: 'CUSTOMER_INSIGHTS_UNAVAILABLE',
        message: 'Customer insights are unavailable. You can continue the sale.',
      });
    }
  });
  it('normalizes the source flat/enveloped briefings and all recommendation/stock fields with safe images', async () => {
    const briefing = {
      user_id: '888',
      customer: { name: '<img onerror=unsafe>', is_exclusive: true },
      occasion: { emoji: '🎂', text: 'Birthday' },
      segment: 'Frequent visitor',
      last_visit: '2026-11-01',
      home_store: 'Fixture store',
      avg_order_value: '1999.5',
      total_spend: 50000,
      customer_since: { date: '2020-01-01', tenure: '6 years' },
      sizes: [{ label: 'Tees', usual_size: 'M', recent_size: 'L', size_drifted: 1 }],
      action_points: [
        {
          kind: 'rec',
          category: 'cart',
          prompt: 'Try this',
          count: 2,
          items: [
            {
              name: 'Safe',
              image_url: 'https://prod-img.thesouledstore.com/products/safe.jpg',
              store: '3',
              online: 5,
              sizes: [{ size: 'L', store: 2, online: '4' }],
            },
            { name: 'Unsafe', image_url: 'javascript:alert(1)' },
            { name: 'Other host', image_url: 'https://tracking.example.test/a.jpg' },
          ],
        },
        { kind: 'action', text: 'Wallet reminder', note: 'Ask first' },
      ],
    };
    for (const body of [briefing, { success: true, data: briefing }]) {
      const result = await customerBriefingGateway(config, options, async () =>
        Response.json(body, { headers }),
      ).read({ id: '777', email: 'guest@example.test', telephone: '' }, '1');
      expect(result.avg_order_value).toBe(1999.5);
      expect(result.user_id).toBe('888');
      expect(result.action_points[0]?.items.map((item) => item.image_url)).toEqual([
        'https://prod-img.thesouledstore.com/products/safe.jpg',
        null,
        null,
      ]);
      expect(result.action_points[0]?.items[0]?.sizes[0]).toEqual({
        size: 'L',
        store: 2,
        online: 4,
      });
      expect(result.action_points[1]?.note).toBe('Ask first');
    }
  });
});
