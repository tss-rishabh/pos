import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  screeningProfileContract,
  screeningSource,
  screeningReservationSchema,
  screeningProof,
  enforceScreeningTicketLimit,
} from '../../src/modules/legacy-order-imports/screening-profile.js';
import { oracle, sourceOracleSchema } from './source.js';
describe('pinned screening counter and source overlay', () => {
  let reference: ReturnType<typeof sourceOracleSchema.parse>;
  beforeAll(() => {
    reference = sourceOracleSchema.parse(oracle());
  });
  it('executes the pinned PosOrder and both cart admission call sites', () => {
    expect(reference.source).toEqual(screeningSource);
    expect(reference.sourceChecks).toEqual({ cart: 2, pos: 1 });
    expect(reference.counter.exact).toBe('9007199254740993');
    expect(reference.counter.guest).toBe(0);
    expect(reference.counter.readErrorFallback).toBe(0);
  });
  it('matches all 12 original admission decisions and retains the three exact messages as evidence', () => {
    for (const item of reference.limit) {
      const work = () => enforceScreeningTicketLimit(BigInt(item.bought), item.quantity);
      if (item.allowed) expect(work).not.toThrow();
      else expect(work).toThrow(expect.objectContaining({ code: 'ORDER_IMPORT_SCREENING_LIMIT' }));
    }
    expect([...new Set(reference.limit.map((row) => row.message).filter(Boolean))]).toEqual([
      'Only 2 max quantity can be added at once',
      "You've already bought 1 ticket. You can add only 1 more (2 max per customer)",
      'Already bought the maximum quantity',
    ]);
  });
  it('executes original HP constructors and marker branch in both line modes without changing row-count semantics', () => {
    expect(
      reference.modes.map((row) => ({
        unitMode: row.unitMode,
        quantity: row.quantity,
        count: row.markerCount,
        quantities: row.lines.map((line) => line.quantity),
      })),
    ).toEqual([
      { unitMode: false, quantity: 1, count: 1, quantities: [1] },
      { unitMode: false, quantity: 2, count: 1, quantities: [2] },
      { unitMode: true, quantity: 1, count: 1, quantities: [1] },
      { unitMode: true, quantity: 2, count: 2, quantities: [1, 1] },
    ]);
    for (const vector of reference.modes)
      expect(
        vector.lines.every((row) => row.productId === '390238' && row.subProductId === '0'),
      ).toBe(true);
  });
  it('removes only the screening rejection and retains independent membership, quantity, benefit and tender gates', () => {
    expect(reference.profiles).toEqual([
      { name: 'original-screening', code: 'ORDER_IMPORT_SCREENING_PROFILE_REQUIRED' },
      { name: 'qualified-screening', code: null },
      { name: 'membership-retained', code: 'ORDER_IMPORT_MEMBERSHIP_PROFILE_REQUIRED' },
      { name: 'quantity-retained', code: 'ORDER_IMPORT_AUTO_BENEFIT_PROFILE_REQUIRED' },
      { name: 'benefit-retained', code: 'ORDER_IMPORT_AUTO_BENEFIT_PROFILE_REQUIRED' },
      { name: 'tender-retained', code: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH' },
    ]);
  });
  it('shares a strict purpose-bound reservation seal with the Python receiver and rejects changed pins/phase/proof', () => {
    const key = 'screening-synthetic-cross-runtime-proof-'.repeat(2),
      value = screeningReservationSchema.parse({
        contract: screeningProfileContract,
        source: screeningSource,
        scope: { actorId: '1', storeId: '1', counterId: '2', operationId: randomUUID() },
        customerId: '77',
        sku: '390238',
        kind: 'offline',
        planHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        authorityHash: 'c'.repeat(64),
        catalogHash: 'd'.repeat(64),
        quantity: 2,
        markerRows: 1,
        lineItemsEnabled: false,
        sourceCountBefore: '0',
        pendingBefore: 0,
        phase: 'RESERVED',
        orderId: null,
        lines: [],
        markers: [],
        sourceReceiptHash: null,
        completionHash: null,
        rejectionHash: null,
        version: 1,
        createdAt: 1000,
        updatedAt: 1000,
      }),
      row = {
        operation_id: value.scope.operationId,
        customer_id: '77',
        sku: '390238',
        order_id: null,
        data: value,
        proof_hash: screeningProof(key, 'state', value),
      };
    expect(oracle({ action: 'state', key, row })).toEqual({ phase: 'RESERVED', quantity: 2 });
    for (const changed of [
      { ...row, proof_hash: '0'.repeat(64) },
      { ...row, data: { ...value, source: { ...screeningSource, apiCommit: '0'.repeat(40) } } },
      { ...row, data: { ...value, phase: 'COUNTED' } },
    ]) {
      expect(oracle({ action: 'state', key, row: changed })).toEqual({
        code: 'ORDER_IMPORT_SCREENING_PROOF_INVALID',
      });
    }
    expect(screeningReservationSchema.safeParse({ ...value, phase: 'COUNTED' }).success).toBe(
      false,
    );
  });
});
