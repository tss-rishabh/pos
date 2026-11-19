import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { checkoutFlags, exchangeFeatureEnabled } from '../../src/modules/checkout/legacy-flags.js';
import {
  enqueueOrderSms,
  orderSmsHandler,
  ORDER_SMS_JOB,
} from '../../src/modules/checkout/order-sms.js';
import type { JobProducer } from '../../src/jobs/contract.js';

const base = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'legacy-flag-test-session-secret-'.repeat(2),
  MYSQL_PRIMARY_READER_URL: 'mysql://user:pass@127.0.0.1:3306/db',
} as const;

describe('legacy checkout flags (POSAdmin/settings.py)', () => {
  it('uses the legacy defaults', () => {
    const config = readConfig({ ...base });
    expect(config).toMatchObject({
      GLOBAL_SHOW_COUPON_MODULE: 1,
      GLOBAL_SHOW_PG_DISCOUNT_MODULE: 1,
      ENABLE_OLD_PG_DISCOUNT: 1,
      ENABLE_NEW_PG_DISCOUNT: 1,
      ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT: 0,
      TEN_PER_SWITCH: 1,
      EXCHANGE_ENABLED_STORE_IDS: { all: false, storeIds: ['1'] },
    });
  });
  it('parses like Python int() and fails on what int() rejects', () => {
    expect(
      readConfig({ ...base, GLOBAL_SHOW_COUPON_MODULE: ' 0 ' }).GLOBAL_SHOW_COUPON_MODULE,
    ).toBe(0);
    expect(readConfig({ ...base, ENABLE_OLD_PG_DISCOUNT: '+1_0' }).ENABLE_OLD_PG_DISCOUNT).toBe(10);
    for (const value of ['', 'true', '1.0', 'one'])
      expect(() => readConfig({ ...base, TEN_PER_SWITCH: value })).toThrow();
  });
  it('parses EXCHANGE_ENABLED_STORE_IDS as legacy (all, comma ints, blanks skipped)', () => {
    expect(
      readConfig({ ...base, EXCHANGE_ENABLED_STORE_IDS: ' ALL ' }).EXCHANGE_ENABLED_STORE_IDS,
    ).toEqual({ all: true, storeIds: [] });
    expect(
      readConfig({ ...base, EXCHANGE_ENABLED_STORE_IDS: '1, 7,,12 ' }).EXCHANGE_ENABLED_STORE_IDS,
    ).toEqual({ all: false, storeIds: ['1', '7', '12'] });
    expect(() => readConfig({ ...base, EXCHANGE_ENABLED_STORE_IDS: '1,x' })).toThrow();
  });
  it('resolves exchange from the check-in store', () => {
    const config = readConfig({ ...base, EXCHANGE_ENABLED_STORE_IDS: '1,7' });
    expect(exchangeFeatureEnabled(config, '7')).toBe(true);
    expect(exchangeFeatureEnabled(config, '2')).toBe(false);
    expect(exchangeFeatureEnabled(config, null)).toBe(false);
    expect(
      exchangeFeatureEnabled(readConfig({ ...base, EXCHANGE_ENABLED_STORE_IDS: 'all' }), null),
    ).toBe(true);
  });
  it('applies the IN_HOUSE + user_type 1 override to the coupon and PG modules only', () => {
    const config = readConfig({
      ...base,
      GLOBAL_SHOW_COUPON_MODULE: '0',
      GLOBAL_SHOW_PG_DISCOUNT_MODULE: '0',
      ENABLE_OLD_PG_DISCOUNT: '0',
    });
    expect(checkoutFlags(config, 'FRANCHISE', 1)).toMatchObject({
      showCouponModule: false,
      showPgDiscountModule: false,
    });
    expect(checkoutFlags(config, 'IN_HOUSE', 2)).toMatchObject({ showCouponModule: false });
    expect(checkoutFlags(config, 'IN_HOUSE', 1)).toEqual({
      showCouponModule: true,
      showPgDiscountModule: true,
      enableOldPgDiscount: false,
      enableNewPgDiscount: true,
      enableVoucherToMoney: false,
      tenPerSwitch: true,
    });
  });
});

describe('order SMS job (core.tasks.send_sms)', () => {
  it('enqueues the order ID on the core queue and posts it to API-v2 omnichannel-sms', async () => {
    const enqueued: unknown[] = [];
    const jobs: JobProducer = {
      async enqueue(name, args, options) {
        enqueued.push({ name, args, options });
        return { jobId: '1', name, queue: options.queue, dueAt: 0 };
      },
    };
    await enqueueOrderSms(jobs, '7001');
    expect(enqueued).toEqual([
      { name: ORDER_SMS_JOB, args: { order_id: 7001 }, options: { queue: 'core' } },
    ]);
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const handler = orderSmsHandler(
      { TSS_API_BASE_URL: 'https://api.example.test/api/v2' },
      async (input, init) => {
        calls.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: String(init?.body),
        });
        return new Response('{}', { status: 200 });
      },
    );
    const context = {
      jobId: '1',
      name: ORDER_SMS_JOB,
      requestId: null,
      userId: null,
      signal: new AbortController().signal,
    };
    await handler({ order_id: 7001 }, context);
    expect(calls).toEqual([
      {
        url: 'https://api.example.test/api/v2/omnichannel-sms',
        headers: { 'content-type': 'application/json' },
        body: '{"order_id":7001}',
      },
    ]);
    const failing = orderSmsHandler(
      { TSS_API_BASE_URL: 'https://api.example.test/api/v2/' },
      async () => new Response('', { status: 500 }),
    );
    await expect(failing({ order_id: 7001 }, context)).rejects.toMatchObject({
      code: 'ORDER_SMS_REJECTED',
    });
  });
});
