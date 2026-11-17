import { describe, it, expect } from 'vitest';
import {
  reviewOriginalCsvTender,
  sourceTenderUnitSequenceHash,
  type CsvTenderEvidence,
} from '../../src/modules/legacy-order-imports/tender-profile/domain.js';

function evidence(
  tender = '100.00',
  payable = '100.00',
  mode: 'cash' | 'manual-other' = 'cash',
): CsvTenderEvidence {
  const rows = [{ productId: '9007199254740993', quantity: 1, unitPrice: tender }];
  return {
    operationId: '4c3fadfb-29ce-480b-b9f4-5129a36c5b91',
    planHash: 'a'.repeat(64),
    rows,
    declaredTender: tender,
    sourceUnitSequenceHash: sourceTenderUnitSequenceHash(rows),
    originalSourceTenderRaw: tender,
    mode,
    native: {
      orderId: '9007199254740995',
      headerHash: 'b'.repeat(64),
      lineHash: 'c'.repeat(64),
      counterHash: 'd'.repeat(64),
      payable,
      roundingOff: '0.00',
      couponDiscount: '0.00',
      approvedRefundTotal: payable,
      counter: {
        cash: mode === 'cash' ? tender : '0.00',
        received: mode === 'cash' ? tender : '0.00',
        online: '0.00',
        manualOther: mode === 'manual-other' ? tender : '0.00',
      },
    },
  };
}
describe('unselected exact original-tender review candidate', () => {
  it.each(['cash', 'manual-other'] as const)(
    'keeps %s original tender separate from header, rounding and refund',
    (mode) => {
      const input = evidence('50.98', '45.00', mode);
      input.native.roundingOff = '0.89';
      input.native.couponDiscount = '5.10';
      const original = structuredClone(input),
        candidate = reviewOriginalCsvTender(input);
      expect(candidate.classification).toBe('over-collected');
      expect(candidate.financiallyExecutable).toBe(false);
      expect(candidate.amounts).toMatchObject({
        unexplainedDifference: '5.98',
        sourceRoundingOff: '0.89',
        sourceCouponDiscount: '5.10',
        approvedRefundTotal: '45.00',
      });
      expect(candidate.candidateDsr).toEqual({
        cash: mode === 'cash' ? '50.98' : '0.00',
        online: mode === 'manual-other' ? '50.98' : '0.00',
        unallocatedSurplus: '5.98',
        unallocatedShortfall: '0.00',
      });
      expect(candidate.proposedCounterFields.offline_payment).toBe(original.native.counter.cash);
      expect(candidate.orderHeaderAction).toBe('preserve');
      expect(candidate.refundAllocationAction).toBe('preserve');
      expect(candidate.providerAction).toBe('none');
      expect(candidate.cashOutAction).toBe('none');
      expect(candidate.change).toBe('0.00');
      expect(input).toEqual(original);
    },
  );
  it('retains a shortfall without manufacturing its missing funds', () => {
    const candidate = reviewOriginalCsvTender(evidence('80.00', '100.00'));
    expect(candidate.classification).toBe('under-collected');
    expect(candidate.reconciliationRequired).toBe(true);
    expect(candidate.amounts.unexplainedDifference).toBe('-20.00');
    expect(candidate.candidateDsr.unallocatedShortfall).toBe('20.00');
    expect(candidate.proposedCounterFields.offline_payment).toBe('80.00');
  });
  it('keeps the original sub-cent float artifact as audit evidence without inventing currency units', () => {
    const input = evidence('1.00', '1.00');
    input.rows = [{ productId: '10', quantity: 10, unitPrice: '0.10' }];
    input.sourceUnitSequenceHash = sourceTenderUnitSequenceHash(input.rows);
    input.originalSourceTenderRaw = '0.9999999999999999';
    input.native.counter.cash = input.native.counter.received = input.originalSourceTenderRaw;
    const candidate = reviewOriginalCsvTender(input);
    expect(candidate.classification).toBe('balanced');
    expect(candidate.amounts.nativeFloatDrift).toBe('-0.0000000000000001');
    expect(candidate.candidateDsr).toEqual({
      cash: '1.00',
      online: '0.00',
      unallocatedSurplus: '0.00',
      unallocatedShortfall: '0.00',
    });
    expect(candidate.proposedCounterFields.offline_payment).toBe('0.9999999999999999');
  });
  const corruptions = {
    'changed sequence': (value: CsvTenderEvidence) => {
      value.sourceUnitSequenceHash = '0'.repeat(64);
    },
    'invented change': (value: CsvTenderEvidence) => {
      value.native.counter.received = '120.00';
    },
    'invented provider value': (value: CsvTenderEvidence) => {
      value.native.counter.online = '20.00';
    },
    'changed raw source': (value: CsvTenderEvidence) => {
      value.originalSourceTenderRaw = '99.99';
    },
    'invented refund value': (value: CsvTenderEvidence) => {
      value.native.approvedRefundTotal = '99.00';
    },
    'changed declared amount': (value: CsvTenderEvidence) => {
      value.declaredTender = '99.00';
    },
    'wrong tender mode': (value: CsvTenderEvidence) => {
      value.mode = 'manual-other';
    },
    'zero-priced source line': (value: CsvTenderEvidence) => {
      value.rows[0]!.unitPrice = '0.00';
    },
  };
  it.each(Object.entries(corruptions))('refuses %s evidence', (_name, corrupt) => {
    const value = evidence();
    corrupt(value);
    expect(() => reviewOriginalCsvTender(value)).toThrow();
  });
  it('does not make even balanced evidence financially executable', () => {
    const value = reviewOriginalCsvTender(evidence());
    expect(value.classification).toBe('balanced');
    expect(value.financiallyExecutable).toBe(false);
    expect(value.reconciliationRequired).toBe(false);
  });
});
