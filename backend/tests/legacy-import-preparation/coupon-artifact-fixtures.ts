import { randomUUID } from 'node:crypto';
import type { ImportFinancialState } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  prefetchCsvCouponHistory,
  couponHistoryControlHeadHash,
  type CouponHistoryWitness,
  type BirthdayObservation,
} from '../../src/modules/legacy-order-imports/benefit-profile/bridge.js';
import {
  couponHistoryHash,
  type CouponHistoryScope,
  type QualifiedCouponHistory,
} from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import { benefitDigest } from '../../src/modules/legacy-order-imports/benefit-profile/crypto.js';
import { prefetchCsvMembershipHistory } from '../../src/modules/legacy-order-imports/membership-profile/bridge.js';
import {
  csvMembershipHistoryHash,
  type CsvMembershipHistoryRequest,
  type QualifiedCsvMembershipHistory,
} from '../../src/modules/legacy-order-imports/membership-profile/history.js';

const historyKey = 'synthetic-preparation-coupon-history-'.repeat(2),
  sourceProofKey = 'synthetic-preparation-native-head-'.repeat(2),
  guardKey = 'synthetic-preparation-guard-observer-'.repeat(2);
/** Synthetic publication facts for the core ledger transport test only; this
 * fixture does not supply a production provider or all-writer attestation. */
export async function couponArtifact(
  state: ImportFinancialState,
  now: number,
  expiresAt = now + 60000,
) {
  const scope: CouponHistoryScope = {
      contract: 'pos-csv-coupon-history-v1',
      operationId: state.scope.operationId,
      requestHash: state.requestHash,
      planHash: state.planHash,
      customerId: state.authority.customerId,
      couponId: '222',
      configurationHash: 'c'.repeat(64),
      asOf: '2026-06-15 12:00:00',
      sourceTimeZone: 'Asia/Kolkata',
    },
    witness: CouponHistoryWitness = {
      writersContract: 'pos-csv-coupon-history-all-writers-v1',
      writersDefinitionHash: 'd'.repeat(64),
      serverUuid: randomUUID(),
      sourceSchema: 'tss',
      heads: [
        { kind: 'controls', scopeId: '0', revision: '4' },
        { kind: 'coupon', scopeId: '222', revision: '5' },
        { kind: 'customer', scopeId: state.authority.customerId, revision: '6' },
      ],
    },
    guard = {
      contract: 'pos-csv-birthday-cooperative-guard-v1' as const,
      operationId: state.scope.operationId,
      requestHash: state.requestHash,
      customerId: state.authority.customerId,
      observedAt: now,
      present: false,
    },
    observation: BirthdayObservation = {
      ...guard,
      signature: benefitDigest('birthday-observation', guard, guardKey),
    },
    body: Omit<QualifiedCouponHistory, 'signature'> = {
      scope,
      reader: 'bigquery',
      generationId: 'e'.repeat(64),
      complete: true,
      fetchedAt: now,
      publication: {
        sourceCaptureHash: 'f'.repeat(64),
        controlHeadHash: couponHistoryControlHeadHash(scope, witness, sourceProofKey),
        queryContract: 'pos-source-coupon-selects-2960-v1',
        seal: '1'.repeat(64),
      },
      globalUsage: '5',
      birthdayTodayUsage: '0',
      customerOrderCount: '4',
      monthlyJoinedUsage: '8',
      lotCounts: [],
    },
    document = { ...body, signature: couponHistoryHash(body, historyKey) };
  return prefetchCsvCouponHistory(
    { read: async () => document },
    scope,
    witness,
    observation,
    { historyKey, sourceProofKey, guardKey, clock: () => now },
    { signal: new AbortController().signal, expiresAt },
  );
}
export async function membershipArtifact(state: ImportFinancialState, now: number) {
  const scope: CsvMembershipHistoryRequest = {
      contract: 'pos-csv-membership-history-v1',
      operationId: state.scope.operationId,
      requestHash: state.requestHash,
      planHash: state.planHash,
      customerId: state.authority.customerId,
      asOf: '2026-06-15 12:00:00',
      cutoff: '2026-05-01 12:00:00',
    },
    body: Omit<QualifiedCsvMembershipHistory, 'signature'> = {
      scope,
      reader: 'bigquery',
      generationId: 'a'.repeat(64),
      complete: true,
      fetchedAt: now,
      lastDeliveredOrder: null,
      recentDeliveredOrders: [],
    },
    document = { ...body, signature: csvMembershipHistoryHash(body, historyKey) };
  return prefetchCsvMembershipHistory({ read: async () => document }, scope, {
    historyKey,
    memberProductIds: ['10', '12'],
    sourceTimeZone: 'Asia/Kolkata',
    clock: () => now,
  });
}
