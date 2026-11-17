import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { legacyImportFinancialTransport } from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import type { LegacyImportFinancialOptions } from '../../src/modules/legacy-order-imports/financial-adapter-options.js';
import { memberEvidence } from '../legacy-import-membership/adapter-fixtures.js';
import { couponArtifact } from './coupon-artifact-fixtures.js';

const now = Date.parse('2026-06-15T06:30:00Z'),
  authKey = 'fixture-selected-benefit-transport-auth-'.repeat(2),
  sourceProofKey = 'synthetic-preparation-native-head-'.repeat(2);
describe('source-only benefit wire authority', () => {
  it('binds the copied capsule and native marker only to order creation and clips its deadline', async () => {
    const f = memberEvidence(),
      requests: { url: string; body: Record<string, unknown> }[] = [];
    f.state.benefitContracts = { automaticCoupon: 'pos-csv-automatic-coupon-v1' };
    const history = await couponArtifact(f.state, now, now + 5000),
      options: LegacyImportFinancialOptions = {
        secret: 'fixture-benefit-transport-retained-'.repeat(2),
        contract: 'pos-legacy-order-import-financial-v1',
        sourceContract: 'pos-legacy-order-import-source-v1',
        publicationContract: 'pos-legacy-order-import-publication-v1',
        confirmationContract: 'pos-legacy-order-import-confirmation-v1',
        sourceAuthKey: authKey,
        sourceProofKey,
        sourceUrl: 'https://source.fixture.test/internal/pos/legacy-order-imports',
        stockContract: 'pos-stock-projection-70b801-v1',
        stockProcedure: async () => undefined,
        orderSchemaContract: 'pos-offline-cash-order-schema-v1',
        checkout: {
          hs256: 'fixture-benefit-customer-hs256-'.repeat(2),
          hs512: 'fixture-benefit-customer-hs512-'.repeat(2),
          checkoutProjectionContract: 'pos-checkout-projection-v1',
          checkoutProjectionKey: 'fixture-benefit-checkout-projection-'.repeat(2),
          paymentOrderUrl: 'https://payment.fixture.test/confirm',
          refundAllocationContract: 'pos-refund-per-hp-v1',
          refundSourcePatchHash: 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
        },
        fetcher: vi.fn(async (url, init) => {
          requests.push({
            url: String(url),
            body: z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body))),
          });
          return Response.json({ recorded: true });
        }),
      },
      config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'fixture-source-benefit-transport-session-'.repeat(2),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_integration',
      }),
      transport = legacyImportFinancialTransport(config, options),
      command = {
        state: f.state,
        plan: f.plan,
        nonce: crypto.randomUUID(),
        issuedAt: now,
        expiresAt: now + 60000,
        couponHistory: history,
      };
    await transport.order(command);
    const orderCap = z.record(z.string(), z.unknown()).parse(requests[0]!.body.capability),
      { signature, ...body } = orderCap;
    expect(orderCap.benefitContracts).toEqual(f.state.benefitContracts);
    expect(orderCap.couponHistoryHash).toBe(
      financialSourceHash(authKey, 'coupon-history', history),
    );
    expect(orderCap.expiresAt).toBe(now + 5000);
    expect(signature).toBe(financialSourceHash(authKey, 'capability', body));
    expect(requests[0]!.body.couponHistory).toEqual(history);
    await transport.publication(command, f.order);
    const publicationCap = z.record(z.string(), z.unknown()).parse(requests[1]!.body.capability);
    expect(Object.keys(publicationCap)).toHaveLength(14);
    expect(publicationCap).not.toHaveProperty('benefitContracts');
    expect(publicationCap).not.toHaveProperty('couponHistoryHash');
    expect(publicationCap.expiresAt).toBe(now + 60000);
    expect(requests[1]!.body).not.toHaveProperty('couponHistory');
  });
});
