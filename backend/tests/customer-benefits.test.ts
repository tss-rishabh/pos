import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../src/config.js';
import {
  appCashbackCampaign,
  customerBenefitOptions,
} from '../src/modules/customer-insights/benefits-gateway.js';
import {
  customerMembership,
  customerWalletDisplay,
} from '../src/modules/customer-insights/benefits-values.js';
import { goldenStdout } from './golden/load.js';

const config = readConfig({
  NODE_ENV: 'test',
  MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
  SESSION_SECRET: 'benefit-test-private-session-'.repeat(2),
});
const options = customerBenefitOptions({
  TEN_PER_SWITCH: 'true',
  STAGING_CMS_ENDPOINT: 'https://cms.example.test',
});
const oracle = z
  .object({
    helperSha256: z.literal('7a5010baca25487e2020950ea0e129c2a72e0ab664dc6cf3207c7d6bb12f88c0'),
    viewSha256: z.literal('23e3ff32bc197de469f072da53a86eb1ff1bccc669d6f060e8c7c4852ff2f9e0'),
    membershipCases: z.array(
      z.object({
        input: z.object({ value: z.string().nullable(), active: z.number() }).nullable(),
        expected: z.object({
          active: z.boolean(),
          expiry: z.string().nullable(),
          message: z.string(),
        }),
      }),
    ),
    walletCases: z.array(z.object({ input: z.number(), expected: z.string() })),
    eligibilityCases: z.array(
      z.object({
        switch: z.boolean(),
        storefront: z.boolean(),
        campaigns: z.array(z.record(z.string(), z.unknown())),
        appUser: z.number(),
        expectedEligible: z.boolean(),
        expectedApp: z.boolean(),
        providerCalls: z.number(),
      }),
    ),
  })
  .parse(JSON.parse(goldenStdout('core', 'customer-benefits')) as unknown);

describe('pinned current customer benefit behavior', () => {
  it('matches the actual source membership helper across expiry formats and independent active flags', () => {
    for (const vector of oracle.membershipCases)
      expect(
        customerMembership(
          vector.input ?? undefined,
          Temporal.PlainDateTime.from('2026-11-16T10:00:00'),
        ),
      ).toEqual(vector.expected);
    expect(() =>
      customerMembership(
        { value: null, active: null },
        Temporal.PlainDateTime.from('2026-11-16T10:00:00'),
      ),
    ).toThrow();
  });
  it('matches the actual source wallet truncation and separate minimum-one guard', () => {
    for (const vector of oracle.walletCases)
      expect(customerWalletDisplay(vector.input)).toBe(vector.expected);
    expect(() => customerWalletDisplay(Number.NaN)).toThrow();
  });
  it('matches the actual source last-app-campaign and storefront exclusion rules', async () => {
    for (const vector of oracle.eligibilityCases) {
      let calls = 0;
      const campaign = appCashbackCampaign(
        config,
        { ...options, TEN_PER_SWITCH: vector.switch },
        async () => {
          calls++;
          return Response.json({ data: vector.campaigns });
        },
      );
      const active = await campaign.active();
      expect(vector.storefront ? false : active).toBe(vector.expectedEligible);
      expect(vector.appUser !== 0).toBe(vector.expectedApp);
      expect(calls).toBe(vector.providerCalls);
    }
  });
  it('coalesces concurrent provider reads, expires the bounded cache and sends no customer data', async () => {
    let now = 1,
      calls = 0;
    const campaign = appCashbackCampaign(
      config,
      options,
      async (input, init) => {
        calls++;
        expect(String(input)).toBe('https://cms.example.test/api/v2/faq/app-cashback');
        expect(init?.redirect).toBe('error');
        expect(init?.body).toBeUndefined();
        expect(init?.headers).toBeUndefined();
        return Response.json({ data: [{ is_app: true, status: true }] });
      },
      () => now,
    );
    expect(await Promise.all(Array.from({ length: 20 }, () => campaign.active()))).toEqual(
      Array(20).fill(true),
    );
    expect(calls).toBe(1);
    expect(await campaign.active()).toBe(true);
    now += 30001;
    expect(await campaign.active()).toBe(true);
    expect(calls).toBe(2);
  });
  it('marks malformed, oversized, redirected or failed campaign reads unavailable without inventing eligibility', async () => {
    const cases: (typeof fetch)[] = [
      async () => Response.json({ data: [{ is_app: 'true', status: true }] }),
      async () => Response.json({ data: Array(1001).fill({ is_app: true, status: true }) }),
      async () => new Response('fixture-provider-body', { status: 503 }),
      async () => {
        throw new Error('fixture-provider-private-detail');
      },
      async () => new Response('x'.repeat(128001)),
    ];
    for (const fetcher of cases)
      expect(await appCashbackCampaign(config, options, fetcher).active()).toBeNull();
    let calls = 0;
    expect(
      await appCashbackCampaign(
        config,
        { ...options, STAGING_CMS_ENDPOINT: 'https://cms.example.test/?secret=fixture' },
        async () => {
          calls++;
          return Response.json({});
        },
      ).active(),
    ).toBeNull();
    expect(calls).toBe(0);
    expect(() => customerBenefitOptions({ TEN_PER_SWITCH: 'maybe' })).toThrow();
  });
});
