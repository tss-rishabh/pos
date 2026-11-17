import { describe, expect, it } from 'vitest';
import {
  readCsvImportMembershipOptions,
  configuredFinancialImportProfiles,
} from '../../src/modules/legacy-order-imports/membership-profile/options.js';
import { csvMembershipContract } from '../../src/modules/legacy-order-imports/membership-profile/domain.js';
import { adapterOptions, memberEvidence } from './adapter-fixtures.js';
import {
  importCompletedProofSchema,
  importPublicationReceiptSchema,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { assertCsvMembershipPublication } from '../../src/modules/legacy-order-imports/membership-profile/completion.js';
import { financialImportHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';

const selected = () => ({
  POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT: csvMembershipContract,
  POS_MEMBERSHIP_FRESH_READER_CONTRACT: 'pos-membership-fresh-reader-v1',
  POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT: 'pos-membership-native-revision-v1',
  POS_MEMBERSHIP_PROOF_KEY: adapterOptions.membershipProofKey,
  POS_MEMBERSHIP_PRODUCT_IDS: JSON.stringify(adapterOptions.productIds),
  EXCLUSIVE_QUARTERLY_ID_FREE: adapterOptions.freeProductId,
});
describe('trusted financial membership runtime composition', () => {
  it('preserves field absence and exact HMAC bytes for an old ordinary completion', () => {
    const f = memberEvidence(),
      now = f.state.createdAt;
    const raw = {
      contract: 'pos-legacy-order-import-financial-v1',
      receiptId: crypto.randomUUID(),
      scope: f.state.scope,
      planHash: f.state.planHash,
      requestHash: f.state.requestHash,
      authority: f.state.authority,
      kind: f.plan.kind,
      businessDate: f.plan.createdAt.slice(0, 10),
      order: f.order,
      settlement: {
        operationId: f.state.scope.operationId,
        orderId: f.order.orderId,
        kind: f.plan.kind,
        stockHash: 'f'.repeat(64),
        transactionId: null,
        paymentId: null,
        cash: '100.00',
        cashReceived: '100.00',
        manualOther: '0.00',
        recordedAt: f.plan.createdAt,
        finalizedAt: now,
        closeImpactId: null,
        smsJobId: null,
      },
      publication: {
        contract: 'pos-legacy-order-import-publication-v1',
        operationId: f.state.scope.operationId,
        orderId: f.order.orderId,
        requestHash: f.state.requestHash,
        sourceHash: f.order.effectsHash,
        acceptedAt: now,
        delivery: 'durable-queue-accepted',
        jobs: [
          { id: 'one', kind: 'kinesis-chain' },
          { id: 'two', kind: 'engagement' },
        ],
      },
      finalizedAt: now,
    };
    const parsed = importCompletedProofSchema.parse(raw),
      key = 'isolated-completion-master-key-0123456789';
    expect('membership' in parsed).toBe(false);
    expect(financialImportHash(key, 'completed', parsed)).toBe(
      financialImportHash(key, 'completed', raw),
    );
    expect(importCompletedProofSchema.safeParse({ ...raw, membership: null }).success).toBe(false);
  });
  it.each([0, 1, 2] as const)(
    'preserves one private cache task for source invalidation count %s',
    (count) => {
      const f = memberEvidence();
      f.snapshot.receipt.cacheInvalidations = count;
      const proof = importPublicationReceiptSchema.parse({
        contract: 'pos-legacy-order-import-publication-v1',
        operationId: f.state.scope.operationId,
        orderId: f.order.orderId,
        requestHash: f.state.requestHash,
        sourceHash: f.order.effectsHash,
        acceptedAt: f.state.createdAt,
        delivery: 'durable-queue-accepted',
        jobs: [
          { id: 'one', kind: 'kinesis-chain' },
          { id: 'two', kind: 'engagement' },
          ...(count ? [{ id: 'cache', kind: 'membership-cache' }] : []),
        ],
      });
      expect(() => assertCsvMembershipPublication(f.snapshot, proof)).not.toThrow();
      if (count) expect(() => assertCsvMembershipPublication(null, proof)).toThrow();
      const wrong = {
        ...proof,
        jobs: count
          ? proof.jobs.filter((job) => job.kind !== 'membership-cache')
          : [...proof.jobs, { id: 'cache', kind: 'membership-cache' as const }],
      };
      expect(() => assertCsvMembershipPublication(f.snapshot, wrong)).toThrow();
    },
  );
  it('constructs an unselected current-read guard without database access or guessed IDs', () => {
    const options = readCsvImportMembershipOptions({}, {});
    expect(options).toEqual({
      contract: '',
      sourceProofKey: '',
      membershipProofKey: '',
      freshReaderContract: '',
      productIds: [],
      freeProductId: '',
    });
    const profile = configuredFinancialImportProfiles({}, {});
    expect(profile.requiresCurrentReads).toBe(true);
  });
  it('uses the validated financial source key and the exact trusted source product settings', () => {
    const options = readCsvImportMembershipOptions(
      { sourceProofKey: adapterOptions.sourceProofKey },
      { ...selected(), POS_LEGACY_IMPORT_PROOF_KEY: 'ignored-wrong-alias' },
    );
    expect(options).toEqual(adapterOptions);
    expect(() =>
      configuredFinancialImportProfiles(
        { sourceProofKey: adapterOptions.sourceProofKey },
        selected(),
      ).assertReady(memberEvidence().plan),
    ).not.toThrow();
  });
  it.each([
    'source-key',
    'member-key',
    'fresh',
    'native',
    'free',
    'registry',
    'unknown-contract',
    'oversized-registry',
    'duplicate-registry',
  ] as const)('refuses invalid %s configuration with a static error', (changed) => {
    const env: NodeJS.ProcessEnv = selected(),
      financial = { sourceProofKey: adapterOptions.sourceProofKey };
    if (changed === 'source-key') financial.sourceProofKey = '';
    if (changed === 'member-key') env.POS_MEMBERSHIP_PROOF_KEY = '';
    if (changed === 'fresh') env.POS_MEMBERSHIP_FRESH_READER_CONTRACT = '';
    if (changed === 'native') env.POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT = '';
    if (changed === 'free') env.EXCLUSIVE_QUARTERLY_ID_FREE = '0';
    if (changed === 'registry') env.POS_MEMBERSHIP_PRODUCT_IDS = '{}';
    if (changed === 'unknown-contract') env.POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT = 'unapproved';
    if (changed === 'oversized-registry') env.POS_MEMBERSHIP_PRODUCT_IDS = 'x'.repeat(32001);
    if (changed === 'duplicate-registry') env.POS_MEMBERSHIP_PRODUCT_IDS = '["10","10"]';
    expect(() => readCsvImportMembershipOptions(financial, env)).toThrow(
      expect.objectContaining({ code: 'ORDER_IMPORT_MEMBERSHIP_CONFIGURATION_REQUIRED' }),
    );
  });
  it('does not select member admission merely because trusted product IDs are configured', () => {
    const profile = configuredFinancialImportProfiles(
      {},
      { POS_MEMBERSHIP_PRODUCT_IDS: '["10","12"]', EXCLUSIVE_QUARTERLY_ID_FREE: '12' },
    );
    expect(() => profile.assertReady(memberEvidence().plan)).toThrow();
    const ordinary = memberEvidence().plan;
    ordinary.lines[0]!.productId = '11';
    expect(() => profile.assertReady(ordinary)).not.toThrow();
  });
  it('retains a pure recovery port but blocks every new plan when selected configuration becomes invalid', () => {
    const profile = configuredFinancialImportProfiles({}, selected());
    expect(profile.requiresCurrentReads).toBe(true);
    const ordinary = memberEvidence().plan;
    ordinary.lines[0]!.productId = '11';
    for (const plan of [ordinary, memberEvidence().plan])
      expect(() => profile.assertReady(plan)).toThrow(
        expect.objectContaining({ code: 'ORDER_IMPORT_MEMBERSHIP_CONFIGURATION_REQUIRED' }),
      );
  });
});
