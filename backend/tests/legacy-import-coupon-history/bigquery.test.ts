import { couponFactsHash } from '../../src/modules/legacy-order-imports/benefit-profile/history-publication.js';
import { benefitDigest } from '../../src/modules/legacy-order-imports/benefit-profile/crypto.js';
import { describe, expect, it, vi } from 'vitest';
import { couponBigQueryHistory } from '../../src/modules/legacy-order-imports/benefit-profile/history-bigquery.js';
import {
  couponWarehouseCapture,
  sealCouponWarehousePublication,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-publication.js';
import { couponWarehouseSql } from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-query.js';
import {
  couponComparisonFingerprint,
  readCouponBigQueryOptions,
  couponWarehouseRowsHash,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-contracts.js';
import { assertQualifiedCouponHistory } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import { warehouseFixture, comparison } from './warehouse-fixtures.js';
const signal = () => new AbortController().signal;
describe('bounded BQ coupon runtime and independent candidate', () => {
  it('does no constructor I/O; accepts only independently queried published facts under the exact current witness', async () => {
    const f = warehouseFixture(),
      factory = vi.fn(() => {
        throw Error('constructor I/O');
      });
    couponBigQueryHistory(f.options, f.authority, { clientFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    const estimate = vi.fn(async () => 12n),
      execute = vi.fn(async () => f.rows()),
      reader = couponBigQueryHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate, execute },
      });
    const result = await reader.read(f.scope, { witness: f.witness, signal: signal() });
    expect(result).toMatchObject({
      ...f.facts,
      reader: 'bigquery',
      generationId: f.capture.generationId,
      complete: true,
    });
    expect(() =>
      assertQualifiedCouponHistory(result, f.scope, f.authority.historyKey, f.now),
    ).not.toThrow();
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('computes literal global/future/today/first/month multiplication/lot semantics instead of counting source log order_id', () => {
    const f = warehouseFixture();
    expect(f.facts).toEqual({
      globalUsage: '3',
      birthdayTodayUsage: '3',
      customerOrderCount: '6',
      monthlyJoinedUsage: '12',
      lotCounts: [
        {
          couponId: '222',
          sameCode: true,
          noTimesAllowed: '1000',
          uniqueNoTimesAllowed: '10',
          usedCount: '16',
        },
        {
          couponId: '223',
          sameCode: false,
          noTimesAllowed: '1000',
          uniqueNoTimesAllowed: '11',
          usedCount: '1',
        },
      ],
    });
    const sql = couponWarehouseSql(f.options, f.scope, f.capture.controlHeadHash);
    expect(sql.statement).toContain('CAST(l.n AS BIGNUMERIC)*CAST(o.n AS BIGNUMERIC)');
    expect(sql.statement).not.toMatch(/source_facts|global_usage|LOWER\(|ocl\.order_id/);
    expect(JSON.stringify(sql.params)).not.toMatch(
      /SYNTHETIC|FixtureLot|voucher_code|coupon_lot_no/,
    );
    expect(sql.types.asOf).toBe('DATETIME');
    expect(Object.isFrozen(sql)).toBe(true);
    expect(Object.isFrozen(sql.params)).toBe(true);
  });
  it('requires an actually signed native zero capture, complete controls and a publication before returning zero', async () => {
    const f = warehouseFixture(true),
      read = couponBigQueryHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate: async () => 0n, execute: async () => f.rows() },
      });
    expect((await read.read(f.scope, { witness: f.witness, signal: signal() })).globalUsage).toBe(
      '0',
    );
    const missing = f.document();
    missing.manifests = [];
    await expect(
      couponBigQueryHistory(f.options, f.authority, {
        clock: () => f.now,
        query: {
          estimate: async () => 0n,
          execute: async () => [{ document: JSON.stringify(missing) }],
        },
      }).read(f.scope, { witness: f.witness, signal: signal() }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_INCOMPLETE' });
  });
  it('the candidate queries independently before the sealer compares actual warehouse facts to signed native facts', async () => {
    const f = warehouseFixture(),
      execute = vi.fn(async () => f.rows('candidate')),
      candidate = couponWarehouseCapture(
        f.options,
        { sourceKey: f.authority.sourceKey },
        { clock: () => f.now, query: { estimate: async () => 1n, execute } },
      );
    const sealed = await sealCouponWarehousePublication(f.capture, candidate, f.authority, {
      clock: () => f.now,
    });
    expect(sealed).toEqual(f.publication);
    expect(execute).toHaveBeenCalledTimes(1);
    const doc = f.document('candidate');
    doc.facts.monthlyJoinedUsage = '11';
    const wrong = couponWarehouseCapture(
      f.options,
      { sourceKey: f.authority.sourceKey },
      {
        clock: () => f.now,
        query: {
          estimate: async () => 1n,
          execute: async () => [{ document: JSON.stringify(doc) }],
        },
      },
    );
    await expect(
      sealCouponWarehousePublication(f.capture, wrong, f.authority, { clock: () => f.now }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_INCOMPLETE' });
  });
  it.each(['missing', 'old-definition', 'head', 'coupon', 'customer'] as const)(
    'refuses %s witness before estimate',
    async (kind) => {
      const f = warehouseFixture(),
        estimate = vi.fn(async () => 1n),
        w = structuredClone(f.witness);
      if (kind === 'old-definition') w.writersDefinitionHash = '0'.repeat(64);
      if (kind === 'head') w.heads[0].revision = '0';
      if (kind === 'coupon') w.heads[1].scopeId = '999';
      if (kind === 'customer') w.heads[2].scopeId = '999';
      const r = couponBigQueryHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate, execute: async () => f.rows() },
      });
      await expect(
        kind === 'missing' ? r.read(f.scope) : r.read(f.scope, { witness: w, signal: signal() }),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_WITNESS_REQUIRED' });
      expect(estimate).not.toHaveBeenCalled();
    },
  );
  it.each([
    'duplicate',
    'mixed',
    'missing-control',
    'corrupt-flag',
    'wrong-metadata',
    'stale',
    'overflow',
    'head',
    'signature',
    'publication',
    'cdc',
    'invalid',
    'uncovered',
    'oversize',
  ] as const)('rejects %s evidence, never falls back', async (kind) => {
    const f = warehouseFixture(),
      d = f.document();
    if (kind === 'duplicate') d.actual.uniqueOrders = '9';
    if (kind === 'mixed') d.manifests[0]!.snapshotId = '00000000-0000-4000-8000-000000000001';
    if (kind === 'missing-control') d.controls.pop();
    if (kind === 'corrupt-flag') d.controls[2]!.sameCode = true;
    if (kind === 'wrong-metadata') {
      const c = JSON.parse(d.manifests[0]!.controlDocument);
      c.comparison.lot.padAttribute = 'NO PAD';
      d.manifests[0]!.controlDocument = JSON.stringify(c);
    }
    if (kind === 'stale') {
      const c = JSON.parse(d.manifests[0]!.sourceCaptureDocument);
      c.finishedAt -= 61000;
      d.manifests[0]!.sourceCaptureDocument = JSON.stringify(c);
    }
    if (kind === 'overflow') d.facts.monthlyJoinedUsage = '10000000000000000000';
    if (kind === 'head') d.manifests[0]!.controlHeadHash = '0'.repeat(64);
    if (kind === 'signature') {
      const c = JSON.parse(d.manifests[0]!.sourceCaptureDocument);
      c.signature = '0'.repeat(64);
      d.manifests[0]!.sourceCaptureDocument = JSON.stringify(c);
    }
    if (kind === 'publication') {
      const row = d.manifests[0]!;
      if (!('publicationDocument' in row)) throw Error('fixture');
      const p = JSON.parse(row.publicationDocument);
      p.seal = '0'.repeat(64);
      row.publicationDocument = JSON.stringify(p);
    }
    if (kind === 'cdc') d.manifests[0]!.sourceCdcThrough = f.now + 1;
    if (kind === 'invalid') d.actual.invalidLogs = '1';
    if (kind === 'uncovered') d.actual.uncoveredLogs = '1';
    if (kind === 'oversize') d.manifests[0]!.sourceCaptureDocument = 'x'.repeat(262145);
    const execute = vi.fn(async () => [{ document: JSON.stringify(d) }]),
      r = couponBigQueryHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate: async () => 1n, execute },
      });
    await expect(r.read(f.scope, { witness: f.witness, signal: signal() })).rejects.toMatchObject({
      code: expect.stringMatching(/^ORDER_IMPORT_COUPON_PUBLICATION_/),
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects budget, disabled config, wrong project, key reuse, unknown view keys and comparison changes before eligibility', async () => {
    const f = warehouseFixture(),
      execute = vi.fn(async () => f.rows()),
      query = { estimate: async () => BigInt(f.options.CSV_COUPON_MAX_BYTES_BILLED) + 1n, execute };
    await expect(
      couponBigQueryHistory(f.options, f.authority, { clock: () => f.now, query }).read(f.scope, {
        witness: f.witness,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_BUDGET' });
    expect(execute).not.toHaveBeenCalled();
    const disabled = readCouponBigQueryOptions({
      CSV_COUPON_BIGQUERY_CONTRACT: '',
      CSV_COUPON_MAX_BYTES_BILLED: '',
      CSV_COUPON_QUERY_TIMEOUT_MS: '',
      UNRELATED: 'allowed-by-env-selector',
    });
    await expect(
      couponBigQueryHistory(disabled, f.authority).read(f.scope, {
        witness: f.witness,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_REQUIRED' });
    expect(() =>
      couponBigQueryHistory(
        { ...f.options, BQ_CSV_COUPON_ORDERS_VIEW: 'evil.raw.orders' },
        f.authority,
      ),
    ).toThrow();
    expect(() =>
      couponBigQueryHistory(f.options, { ...f.authority, publicationKey: f.authority.sourceKey }),
    ).toThrow();
    expect(
      couponComparisonFingerprint({
        ...comparison,
        lot: { ...comparison.lot, padAttribute: 'NO PAD' },
      }),
    ).not.toBe(f.options.CSV_COUPON_COMPARISON_FINGERPRINT);
    expect(couponWarehouseRowsHash(f.capture, f.controls, f.authority.sourceKey)).toBe(
      f.controlManifest.rowsHash,
    );
  });
  it('rejects a publication-key-authenticated alternate count that disagrees with the independent native signature', async () => {
    const f = warehouseFixture(),
      d = f.document();
    d.facts.monthlyJoinedUsage = '11';
    const pub = {
      ...f.publication,
      sourceFactsHash: couponFactsHash(f.scope, d.facts, f.authority.publicationKey),
      warehouseFactsHash: couponFactsHash(f.scope, d.facts, f.authority.publicationKey),
    };
    const { seal: _seal, ...body } = pub;
    pub.seal = benefitDigest('coupon-publication', body, f.authority.publicationKey);
    const row = d.manifests[0]!;
    if (!('publicationDocument' in row)) throw Error('fixture');
    row.publicationDocument = JSON.stringify(pub);
    await expect(
      couponBigQueryHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate: async () => 0n, execute: async () => [{ document: JSON.stringify(d) }] },
      }).read(f.scope, { witness: f.witness, signal: signal() }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_INCOMPLETE' });
  });
  it('authenticates 10,000 controls in bounded canonical chunks and rejects duplicates', () => {
    const f = warehouseFixture();
    const rows = Array.from({ length: 10000 }, (_, i) => ({
      couponId: String(i + 1),
      present: false,
      lotMatches: false,
      sameCode: false,
      noTimesAllowed: null,
      uniqueNoTimesAllowed: null,
    }));
    const digest = couponWarehouseRowsHash(f.capture, rows, f.authority.sourceKey);
    expect(couponWarehouseRowsHash(f.capture, [...rows].reverse(), f.authority.sourceKey)).toBe(
      digest,
    );
    rows[9999]!.present = true;
    expect(() => couponWarehouseRowsHash(f.capture, rows, f.authority.sourceKey)).toThrow();
    expect(() =>
      couponWarehouseRowsHash(f.capture, [f.controls[0]!, f.controls[0]!], f.authority.sourceKey),
    ).toThrow();
  });
  it('aborts injected uncooperative I/O promptly and cancels its shared deadline without a second query', async () => {
    const f = warehouseFixture(),
      controller = new AbortController(),
      execute = vi.fn(async () => f.rows()),
      r = couponBigQueryHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate: async () => new Promise<bigint>(() => undefined), execute },
      });
    const pending = r.read(f.scope, { witness: f.witness, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_UNAVAILABLE',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
