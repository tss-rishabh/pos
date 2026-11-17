import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { benefitDigest } from '../../src/modules/legacy-order-imports/benefit-profile/crypto.js';
import {
  couponHistoryHash,
  type CouponHistoryScope,
  type QualifiedCouponHistory,
} from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import {
  assertCsvCouponPrefetch,
  couponHistoryControlHeadHash,
  prefetchCsvCouponHistory,
  type BirthdayObservation,
  type CouponHistoryWitness,
  type CsvCouponPrefetchOptions,
} from '../../src/modules/legacy-order-imports/benefit-profile/bridge.js';

function fixture(asOf = '2026-06-15 12:00:00') {
  const now = Date.parse(asOf.replace(' ', 'T') + '+05:30') + 500;
  const options: CsvCouponPrefetchOptions = {
    historyKey: 'fixture-coupon-warehouse-history-'.repeat(2),
    sourceProofKey: 'fixture-source-native-proof-'.repeat(2),
    guardKey: 'fixture-legacy-guard-observer-'.repeat(2),
    clock: () => now,
  };
  const scope: CouponHistoryScope = {
    contract: 'pos-csv-coupon-history-v1',
    operationId: randomUUID(),
    requestHash: 'a'.repeat(64),
    planHash: 'b'.repeat(64),
    customerId: '77',
    couponId: '222',
    configurationHash: 'c'.repeat(64),
    asOf,
    sourceTimeZone: 'Asia/Kolkata',
  };
  const witness: CouponHistoryWitness = {
    writersContract: 'pos-csv-coupon-history-all-writers-v1',
    writersDefinitionHash: 'd'.repeat(64),
    serverUuid: randomUUID(),
    sourceSchema: 'tss',
    heads: [
      { kind: 'controls', scopeId: '0', revision: '4' },
      { kind: 'coupon', scopeId: '222', revision: '5' },
      { kind: 'customer', scopeId: '77', revision: '6' },
    ],
  };
  const guard = {
    contract: 'pos-csv-birthday-cooperative-guard-v1' as const,
    operationId: scope.operationId,
    requestHash: scope.requestHash,
    customerId: '77',
    observedAt: now,
    present: false,
  };
  const observation: BirthdayObservation = {
    ...guard,
    signature: benefitDigest('birthday-observation', guard, options.guardKey),
  };
  const body: Omit<QualifiedCouponHistory, 'signature'> = {
    scope,
    reader: 'bigquery',
    generationId: 'e'.repeat(64),
    complete: true,
    fetchedAt: now,
    publication: {
      sourceCaptureHash: 'f'.repeat(64),
      controlHeadHash: couponHistoryControlHeadHash(scope, witness, options.sourceProofKey),
      queryContract: 'pos-source-coupon-selects-2960-v1',
      seal: '1'.repeat(64),
    },
    globalUsage: '5',
    birthdayTodayUsage: '0',
    customerOrderCount: '4',
    monthlyJoinedUsage: '8',
    lotCounts: [],
  };
  const document: QualifiedCouponHistory = {
    ...body,
    signature: couponHistoryHash(body, options.historyKey),
  };
  return {
    scope,
    witness,
    observation,
    document,
    options,
    now,
    request: { signal: new AbortController().signal, expiresAt: now + 60000 },
  };
}
describe('purpose-bound coupon history prefetch capsule', () => {
  it('copies signed complete history and exact witnesses outside SQL for pure in-memory validation', async () => {
    const f = fixture(),
      read = vi.fn(async () => structuredClone(f.document));
    const value = await prefetchCsvCouponHistory(
      { read },
      f.scope,
      f.witness,
      f.observation,
      f.options,
      f.request,
    );
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]).toEqual([f.scope, { witness: f.witness, signal: f.request.signal }]);
    expect(assertCsvCouponPrefetch(value, f.scope, f.options)).toEqual(value);
    expect(Object.isFrozen(value.document.scope)).toBe(true);
    expect(value.capability.expiresAt).toBe(f.now - 500 + 60000);
  });
  it('ends the daily decision at exact source midnight even within the60-second lease', async () => {
    const f = fixture('2026-06-15 23:59:50');
    const value = await prefetchCsvCouponHistory(
      { read: async () => f.document },
      f.scope,
      f.witness,
      f.observation,
      f.options,
      f.request,
    );
    expect(value.capability.expiresAt).toBe(Date.parse('2026-06-15T18:30:00.000Z'));
    expect(() =>
      assertCsvCouponPrefetch(value, f.scope, {
        ...f.options,
        clock: () => value.capability.expiresAt,
      }),
    ).toThrow();
  });
  it.each(['history', 'observation', 'witness', 'scope', 'generation', 'expiry'] as const)(
    'rejects modified %s without accepting a replacement generation',
    async (field) => {
      const f = fixture(),
        value = structuredClone(
          await prefetchCsvCouponHistory(
            { read: async () => f.document },
            f.scope,
            f.witness,
            f.observation,
            f.options,
            f.request,
          ),
        );
      if (field === 'history') value.document.globalUsage = '0';
      if (field === 'observation') value.guardObservation.present = true;
      if (field === 'witness') value.witness.heads[1].revision = '7';
      if (field === 'scope') value.capability.scope.customerId = '78';
      if (field === 'generation') value.capability.generationId = '9'.repeat(64);
      if (field === 'expiry') value.capability.expiresAt += 1;
      expect(() => assertCsvCouponPrefetch(value, f.scope, f.options)).toThrow();
    },
  );
  it('refuses mismatched publication/control heads despite an otherwise signed BQ document', async () => {
    const f = fixture(),
      { signature: _signature, ...body } = f.document;
    body.publication = { ...body.publication, controlHeadHash: '9'.repeat(64) };
    const document = { ...body, signature: couponHistoryHash(body, f.options.historyKey) };
    await expect(
      prefetchCsvCouponHistory(
        { read: async () => document },
        f.scope,
        f.witness,
        f.observation,
        f.options,
        f.request,
      ),
    ).rejects.toThrow();
  });
  it('validates keys, native witness scope, guard receipt, lease and abort before the provider call', async () => {
    const f = fixture(),
      read = vi.fn(async () => f.document);
    await expect(
      prefetchCsvCouponHistory(
        { read },
        f.scope,
        f.witness,
        { ...f.observation, present: true },
        f.options,
        f.request,
      ),
    ).rejects.toThrow();
    await expect(
      prefetchCsvCouponHistory(
        { read },
        f.scope,
        {
          ...f.witness,
          heads: [
            f.witness.heads[0],
            { ...f.witness.heads[1], scopeId: '223' },
            f.witness.heads[2],
          ],
        },
        f.observation,
        f.options,
        f.request,
      ),
    ).rejects.toThrow();
    await expect(
      prefetchCsvCouponHistory(
        { read },
        f.scope,
        f.witness,
        f.observation,
        { ...f.options, guardKey: f.options.historyKey },
        f.request,
      ),
    ).rejects.toThrow();
    await expect(
      prefetchCsvCouponHistory({ read }, f.scope, f.witness, f.observation, f.options, {
        ...f.request,
        expiresAt: f.now,
      }),
    ).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(
      prefetchCsvCouponHistory({ read }, f.scope, f.witness, f.observation, f.options, {
        ...f.request,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('captures scope and controls before waiting and never adopts later caller changes', async () => {
    const f = fixture(),
      snapshot = structuredClone(f.document);
    let finish!: (value: QualifiedCouponHistory) => void;
    const pending = new Promise<QualifiedCouponHistory>((resolve) => {
      finish = resolve;
    });
    const result = prefetchCsvCouponHistory(
      { read: async () => pending },
      f.scope,
      f.witness,
      f.observation,
      f.options,
      f.request,
    );
    f.scope.customerId = '78';
    f.witness.heads[2].scopeId = '78';
    f.observation.present = true;
    finish(snapshot);
    expect((await result).document.scope.customerId).toBe('77');
  });
  it('has no provider/empty-history fallback and bounds a retained capsule', async () => {
    const f = fixture();
    await expect(
      prefetchCsvCouponHistory(
        {
          read: async () => {
            throw new Error('fixture provider unavailable');
          },
        },
        f.scope,
        f.witness,
        f.observation,
        f.options,
        f.request,
      ),
    ).rejects.toThrow();
    expect(() =>
      assertCsvCouponPrefetch({ document: 'x'.repeat(300001) }, f.scope, f.options),
    ).toThrow();
  });
});
