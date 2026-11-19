import { describe, expect, it } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import {
  checkUserExclusiveAdapter,
  customerLookupQuery,
  customerLookupService,
  type CheckUserExclusiveAdapter,
} from '../../src/modules/checkout/customers/lookup.js';

/** Legacy `AjaxUserDetailsView` (`users/views.py:612-664`) and `create_order.html:2905-2984`. */
const config = {
  TSS_API_BASE_URL: 'https://api-v2.example.test/api/v2/',
  NODE_ENV: 'test' as const,
};
const options = { API_V2_APP_ID: 'fixture-app', API_V2_APP_KEY: 'fixture-key' };
function fakeDb(queue: unknown[][]): Databases {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(queue.shift() ?? []),
  };
  return { get: () => chain } as unknown as Databases;
}
const found = {
  message: 'User Found',
  data: {
    user_id: 42,
    name: 'Fixture Customer',
    telephone: '9876500001',
    email: 'fixture@example.com',
    customer_type: 'B2B',
    gstin: '29ABCDE1234F1Z5',
  },
};

describe('customer lookup through API-v2 check-user-exclusive', () => {
  it('keeps the legacy query formats', () => {
    expect(customerLookupQuery({ telephone: '98765_____', email: ' a@b.c ' })).toEqual({
      email: 'a@b.c',
      telephone: 0,
    });
    expect(customerLookupQuery({ telephone: '9876500001', email: 'a@b.c' })).toEqual({
      email: 'a@b.c',
      telephone: '9876500001',
    });
    expect(() => customerLookupQuery({ telephone: '', email: '' })).toThrowError(
      expect.objectContaining({ status: 400, message: 'Please Provide Email/Telephone.' }),
    );
  });

  it('posts with the app headers only and relays blocked/unknown messages', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let next: () => Response = () => Response.json(found);
    const adapter = checkUserExclusiveAdapter(config, options, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return next();
    });
    await expect(adapter.check({ email: '', telephone: '9876500001' })).resolves.toMatchObject({
      kind: 'found',
      customer: { user_id: 42 },
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api-v2.example.test/api/v2/check-user-exclusive',
      init: {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Ar_app_id: 'fixture-app',
          Ar_app_key: 'fixture-key',
        },
        body: JSON.stringify({ email: '', telephone: '9876500001' }),
      },
    });
    next = () => Response.json({ message: 'User is blocked.' }, { status: 404 });
    await expect(adapter.check({ email: 'x@y.z', telephone: 0 })).resolves.toEqual({
      kind: 'not-found',
      message: 'User is blocked.',
    });
    next = () => new Response('oops', { status: 500 });
    await expect(adapter.check({ email: 'x@y.z', telephone: 0 })).resolves.toEqual({
      kind: 'not-found',
      message: 'User Not Found.',
    });
    next = () => {
      throw new TypeError('network');
    };
    await expect(adapter.check({ email: 'x@y.z', telephone: 0 })).rejects.toMatchObject({
      status: 503,
      message: 'Unable to fetch user details. Please try again.',
    });
  });

  it('adds the exclusive membership and app-cashback eligibility as legacy', async () => {
    const adapter: CheckUserExclusiveAdapter = {
      check: async () => ({ kind: 'found', message: found.message, customer: found.data }),
    };
    const now = () => Date.parse('2026-11-19T06:30:00Z');
    let queue: unknown[][] = [[{ value: '2027-03-05 00:00:00', active: 1 }], []];
    const service = (active: boolean | null) =>
      customerLookupService(
        fakeDb(queue),
        { BUSINESS_TIMEZONE: 'Asia/Kolkata' },
        { adapter, campaign: { active: async () => active }, now },
      );
    await expect(service(true).lookup({ telephone: '9876500001', email: '' })).resolves.toEqual({
      customer: {
        id: '42',
        name: 'Fixture Customer',
        telephone: '9876500001',
        email: 'fixture@example.com',
        customerType: 'B2B',
        gstin: '29ABCDE1234F1Z5',
      },
      message: 'User Found',
      exclusive: { member: true, expiry: '2027-03-05T00:00:00', message: '' },
      discountEligible: true,
    });
    // A storefront account is never eligible; a failed CMS read is "not eligible".
    queue = [[{ value: '2027-03-05 00:00:00', active: 0 }], [{ id: 42n }]];
    await expect(
      service(true).lookup({ telephone: '9876500001', email: '' }),
    ).resolves.toMatchObject({
      exclusive: { member: false, message: "User's Membership is deactivated." },
      discountEligible: false,
    });
    queue = [[]];
    await expect(
      service(null).lookup({ telephone: '9876500001', email: '' }),
    ).resolves.toMatchObject({
      exclusive: { member: false, expiry: null, message: '' },
      discountEligible: false,
    });
    const missing: CheckUserExclusiveAdapter = {
      check: async () => ({ kind: 'not-found', message: 'User is blocked.' }),
    };
    await expect(
      customerLookupService(
        fakeDb([]),
        { BUSINESS_TIMEZONE: 'Asia/Kolkata' },
        { adapter: missing, campaign: { active: async () => true } },
      ).lookup({ telephone: '', email: 'x@y.z' }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'CUSTOMER_NOT_FOUND',
      message: 'User is blocked.',
    });
  });
});
