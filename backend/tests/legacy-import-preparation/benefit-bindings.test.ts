import { describe, expect, it } from 'vitest';
import { benefitFixture, now, sourceKey } from '../legacy-import-benefits/fixture.js';
import {
  financialBenefitContractsSchema,
  importFinancialStateSchema,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  financialImportRequestHash,
  financialImportHash,
  financialSourceHash,
} from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import {
  financialPreparationLedger,
  financialPreparationMaximumArtifactBytes,
} from '../../src/modules/legacy-order-imports/financial-adapter-preparation-ledger.js';
import { couponArtifact, membershipArtifact } from './coupon-artifact-fixtures.js';
import type { CsvBenefitProfileOptions } from '../../src/modules/legacy-order-imports/benefit-profile/adapter.js';

const marker = { automaticCoupon: 'pos-csv-automatic-coupon-v1' as const };
describe('immutable optional import benefit contracts', () => {
  it.each([
    {},
    null,
    { automaticCoupon: '' },
    { automaticCoupon: 'wrong' },
    { complementary: 'wrong' },
    { automaticCoupon: marker.automaticCoupon, unknown: true },
  ])('refuses malformed/empty marker %#', (value) => {
    expect(financialBenefitContractsSchema.safeParse(value).success).toBe(false);
  });
  it('keeps absent original fields and HMAC bytes exactly while binding selected behavior', () => {
    const f = benefitFixture(),
      secret = 'fixture-retained-financial-key-'.repeat(2),
      input = {
        scope: f.state.scope,
        planHash: f.state.planHash,
        plan: f.plan,
        authority: f.state.authority,
      };
    expect(Object.hasOwn(importFinancialStateSchema.parse(f.state), 'benefitContracts')).toBe(
      false,
    );
    expect(financialImportRequestHash(secret, input)).toBe(
      financialImportHash(secret, 'request', input),
    );
    expect(financialImportRequestHash(secret, { ...input, benefitContracts: undefined })).toBe(
      financialImportRequestHash(secret, input),
    );
    expect(financialImportRequestHash(secret, { ...input, benefitContracts: marker })).not.toBe(
      financialImportRequestHash(secret, input),
    );
  });
  it('compares saved source behavior with trusted server profile selection', () => {
    const selected = financialAdapterProfiles({
        benefits: { ...marker, sourceProofKey: sourceKey },
      }),
      plain = financialAdapterProfiles();
    expect(selected.benefitContracts).toEqual(marker);
    expect(() => selected.assertBindings({})).toThrow();
    expect(() => plain.assertBindings({ benefitContracts: marker })).toThrow();
    expect(() => selected.assertBindings({ benefitContracts: marker })).not.toThrow();
  });
  it('captures trusted flags rather than letting later object mutation activate reserved behavior', () => {
    const options: CsvBenefitProfileOptions = { sourceProofKey: sourceKey },
      profile = financialAdapterProfiles({ benefits: options });
    options.automaticCoupon = marker.automaticCoupon;
    expect(profile.benefitContracts).toBeUndefined();
    expect(() => profile.assertBindings({ benefitContracts: marker })).toThrow();
  });
  it('uses a separate source purpose for a coupon capsule', () => {
    const value = { fixture: 'bound-artifact' };
    expect(financialSourceHash(sourceKey, 'coupon-history', value)).not.toBe(
      financialSourceHash(sourceKey, 'membership-history', value),
    );
  });
});
describe('bounded combined preparation artifacts', () => {
  it('copies both exact documents with unchanged scope into the aggregate artifact', async () => {
    const f = benefitFixture(),
      state = { ...f.state, benefitContracts: marker },
      ledger = financialPreparationLedger(sourceKey, () => now),
      value = {
        couponHistory: await couponArtifact(state, now),
        membershipHistory: await membershipArtifact(state, now),
      };
    expect(ledger.artifact(state, value, now + 60000)).toEqual(value);
    expect(ledger.artifact(state, {}, now + 60000)).toEqual({});
  });
  it.each([
    'unselected',
    'request',
    'customer',
    'document-scope',
    'generation',
    'attempt-expiry',
    'expired',
  ])('refuses %s before a dispatch checkpoint', async (mutation) => {
    const f = benefitFixture(),
      state = { ...f.state, benefitContracts: marker },
      ledger = financialPreparationLedger(sourceKey, () => now),
      value = { couponHistory: structuredClone(await couponArtifact(state, now)) };
    if (mutation === 'request') value.couponHistory.capability.scope.requestHash = '0'.repeat(64);
    if (mutation === 'customer') value.couponHistory.capability.scope.customerId = '99';
    if (mutation === 'document-scope') value.couponHistory.document.scope.customerId = '99';
    if (mutation === 'generation') value.couponHistory.capability.generationId = '0'.repeat(64);
    if (mutation === 'attempt-expiry') value.couponHistory.capability.expiresAt = now + 60001;
    if (mutation === 'expired') value.couponHistory.capability.expiresAt = now;
    expect(() =>
      ledger.artifact(mutation === 'unselected' ? f.state : state, value, now + 60000),
    ).toThrow();
  });
  it('rejects a coupon capsule above300000 bytes and an aggregate above1MiB without truncating or stripping fields', () => {
    const f = benefitFixture(),
      state = { ...f.state, benefitContracts: marker },
      ledger = financialPreparationLedger(sourceKey, () => now);
    expect(() =>
      ledger.artifact(state, { couponHistory: { oversized: 'x'.repeat(300001) } }),
    ).toThrow();
    expect(() =>
      ledger.artifact(state, {
        membershipHistory: { oversized: 'x'.repeat(financialPreparationMaximumArtifactBytes) },
      }),
    ).toThrow();
  });
});
