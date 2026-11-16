import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('private source membership reader compatibility candidate', () => {
  it('checks pinned reader/producer composition and isolated authority/cache/privacy cases without rewriting evidence', () => {
    const paths = [
      'compatibility/upstream/pending-cancellation/api-v2-membership-reader.patch',
      'compatibility/upstream/pending-cancellation/membership-reader-manifest.json',
      'compatibility/upstream/pending-cancellation/api-v2-membership-producers.patch',
      'compatibility/upstream/pending-cancellation/membership-producer-manifest.json',
    ];
    const before = paths.map((path) => ({
      bytes: readFileSync(path, 'utf8'),
      modified: statSync(path).mtimeMs,
    }));
    execFileSync(
      'python3',
      [
        '-B',
        '-m',
        'unittest',
        'discover',
        '-s',
        'compatibility/upstream/pending-cancellation',
        '-p',
        'test_*.py',
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(
      paths.map((path) => ({
        bytes: readFileSync(path, 'utf8'),
        modified: statSync(path).mtimeMs,
      })),
    ).toEqual(before);
  });
});

import { readConfig } from '../../src/config.js';
import { checkoutGateway, type CheckoutEnvironment } from '../../src/modules/checkout/gateway.js';
import { issueCustomerToken } from '../../src/modules/checkout/crypto.js';
import { customerContextContract } from '../../src/modules/checkout/customer-context.js';
import {
  verifiedMembershipContext,
  membershipContextContract,
} from '../../src/modules/checkout/cancellations/membership-context.js';
import { identity, signingEnvironment } from './fixtures.js';

describe('private membership response binding', () => {
  it('rejects missing/malformed revisions and accepts exact native unsigned revisions including zero', () => {
    for (const revision of ['0', '9007199254740993', '18446744073709551615'])
      expect(
        verifiedMembershipContext(
          new Headers({
            'X-POS-Membership-Context': membershipContextContract,
            'X-POS-Membership-Revision': revision,
          }),
        ),
      ).toBe(true);
    for (const revision of ['', '-1', '00', '1.1', '18446744073709551616'])
      expect(
        verifiedMembershipContext(
          new Headers({
            'X-POS-Membership-Context': membershipContextContract,
            'X-POS-Membership-Revision': revision,
          }),
        ),
      ).toBe(false);
    expect(verifiedMembershipContext(new Headers())).toBe(false);
  });
});

describe('gateway membership contract enforcement', () => {
  it('requires fresh membership evidence on successful private POS mutations and never retries a missing proof', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'isolated-gateway-key-'.repeat(3),
        TSS_API_BASE_URL: 'https://api.example.invalid/api/v2/',
        MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_checkout_test',
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
      environment: CheckoutEnvironment = {
        ...signingEnvironment,
        postOrderBaseUrl: 'https://api.example.invalid/api/v2/',
        customerContextContract,
        customerContextKey: 'isolated-customer-purpose-key-'.repeat(2),
        membershipContextContract,
      };
    const token = issueCustomerToken(identity('777'), environment);
    const badHeaders: Record<string, string>[] = [
      {},
      { 'X-POS-Membership-Context': 'wrong', 'X-POS-Membership-Revision': '1' },
      { 'X-POS-Membership-Context': membershipContextContract, 'X-POS-Membership-Revision': '-1' },
    ];
    for (const extra of badHeaders) {
      let calls = 0;
      const gateway = checkoutGateway(config, environment, async () => {
        calls++;
        return new Response(JSON.stringify({ status: 'success' }), {
          headers: {
            'Content-Type': 'application/json',
            'X-POS-Customer-Context': customerContextContract,
            'X-POS-Customer-ID': '777',
            ...extra,
          },
        });
      });
      await expect(
        gateway.api('pos/order', { is_pos: true, store_id: 1 }, token),
      ).rejects.toMatchObject({ code: 'MEMBERSHIP_CONTEXT_PROOF_MISSING', uncertain: true });
      expect(calls).toBe(1);
    }
    const gateway = checkoutGateway(
      config,
      environment,
      async () =>
        new Response(JSON.stringify({ status: 'success' }), {
          headers: {
            'Content-Type': 'application/json',
            'X-POS-Customer-Context': customerContextContract,
            'X-POS-Customer-ID': '777',
            'X-POS-Membership-Context': membershipContextContract,
            'X-POS-Membership-Revision': '9007199254740993',
          },
        }),
    );
    expect(await gateway.api('pos/order', { is_pos: true, store_id: 1 }, token)).toEqual({
      status: 'success',
    });
  });
});
