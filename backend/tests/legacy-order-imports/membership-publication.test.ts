import { afterEach, describe, expect, it, vi } from 'vitest';
import { csvMembershipBigQueryHistory } from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import {
  csvMembershipCandidateSql,
  csvMembershipWarehouseCapture,
} from '../../src/modules/legacy-order-imports/membership-profile/publication-warehouse.js';
import {
  sealCsvMembershipHistoryPublication,
  verifyCsvMembershipSourceCapture,
  type CsvMembershipSourceCapture,
} from '../../src/modules/legacy-order-imports/membership-profile/publication.js';
import {
  membershipBigQueryFixture,
  membershipHistoryAuthority,
  membershipHistoryNow,
  membershipHistoryOptions,
  membershipHistoryScope,
} from './membership-bigquery-fixtures.js';
import {
  membershipCandidateView,
  membershipSourceKey,
  publicationAuthority,
  sourceCaptureFixture,
  warehouseCaptureFixture,
} from './membership-publication-fixtures.js';

afterEach(() => vi.useRealTimers());
function setup() {
  const capture = sourceCaptureFixture(),
    facts = warehouseCaptureFixture(capture),
    estimate = vi.fn(async () => 1n),
    execute = vi.fn(async () => [{ document: JSON.stringify(facts) }]);
  const warehouse = csvMembershipWarehouseCapture(
    membershipHistoryOptions,
    membershipCandidateView,
    { sourceKey: membershipSourceKey, memberProductIds: ['10', '12'] },
    { clock: () => membershipHistoryNow, query: { estimate, execute } },
  );
  return {
    capture,
    facts,
    estimate,
    execute,
    warehouse,
    seal: () =>
      sealCsvMembershipHistoryPublication(capture, warehouse, publicationAuthority, {
        sourceTimeZone: 'Asia/Kolkata',
        clock: () => membershipHistoryNow,
      }),
  };
}
describe('source-authenticated complete membership publication producer', () => {
  it('compares source and independently queried warehouse rows before emitting a complete reader-compatible manifest', async () => {
    const f = setup(),
      result = await f.seal();
    expect(result.publication).toMatchObject({
      sourceComplete: true,
      generationId: f.capture.generationId,
      sourceOrderCount: f.capture.orderCount,
      warehouseOrderCount: f.capture.orderCount,
      sourceHistoryHash: f.capture.historyHash,
      warehouseHistoryHash: f.capture.historyHash,
    });
    expect(f.estimate).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    const reader = csvMembershipBigQueryHistory(
      membershipHistoryOptions,
      membershipHistoryAuthority,
      {
        clock: () => membershipHistoryNow,
        query: {
          estimate: async () => 0n,
          execute: async () => [
            {
              document: JSON.stringify({
                publications: [result.publication],
                actual: f.facts.actual,
                orders: f.facts.orders,
                lines: f.facts.lines,
              }),
            },
          ],
        },
      },
    );
    expect((await reader.read(membershipHistoryScope)).lastDeliveredOrder).toEqual(
      f.capture.selection.lastDeliveredOrder,
    );
  });
  it('requires a real staged empty candidate as well as a signed native zero', async () => {
    const capture = sourceCaptureFixture([]),
      facts = warehouseCaptureFixture(capture, []),
      execute = vi.fn(async () => [{ document: JSON.stringify(facts) }]);
    const warehouse = csvMembershipWarehouseCapture(
      membershipHistoryOptions,
      membershipCandidateView,
      { sourceKey: membershipSourceKey, memberProductIds: ['10', '12'] },
      { clock: () => membershipHistoryNow, query: { estimate: async () => 0n, execute } },
    );
    expect(
      (
        await sealCsvMembershipHistoryPublication(capture, warehouse, publicationAuthority, {
          sourceTimeZone: 'Asia/Kolkata',
          clock: () => membershipHistoryNow,
        })
      ).publication.sourceOrderCount,
    ).toBe('0');
    facts.controls = [];
    await expect(warehouse.read(capture)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_WAREHOUSE_INCOMPLETE',
    });
  });
  it.each(['generationId', 'sourceSnapshotId', 'scope', 'historyHash', 'orderCount', 'signature'])(
    'refuses tampered source %s before any warehouse call',
    async (field) => {
      const f = setup();
      Object.assign(f.capture, {
        [field]: field === 'scope' ? { ...f.capture.scope, customerId: '2' } : 'tampered',
      });
      await expect(f.seal()).rejects.toMatchObject({
        code: expect.stringMatching(/^ORDER_IMPORT_MEMBERSHIP_/),
      });
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it.each([
    'generationId',
    'customerId',
    'asOf',
    'cutoff',
    'sourceTimeZone',
    'sourceSnapshotId',
    'sourceCaptureHash',
  ])('refuses a warehouse candidate with changed %s', async (field) => {
    const f = setup();
    Object.assign(f.facts.controls[0]!, {
      [field]:
        field === 'customerId'
          ? '2'
          : field === 'sourceSnapshotId'
            ? '02e9c57c-7b36-4f58-9651-8d61b7317ddc'
            : field === 'asOf' || field === 'cutoff'
              ? '2026-11-17 12:00:01'
              : field === 'sourceTimeZone'
                ? 'UTC'
                : 'd'.repeat(64),
    });
    await expect(f.seal()).rejects.toMatchObject({
      code: expect.stringMatching(/^ORDER_IMPORT_MEMBERSHIP_/),
    });
  });
  it('does not seal a partial count, missing HP, changed flag or caller complete assertion', async () => {
    for (const change of ['count', 'missing-line', 'changed-flag', 'incomplete']) {
      const f = setup();
      if (change === 'count') f.facts.actual.orders = '999';
      if (change === 'missing-line') f.facts.lines = [];
      if (change === 'changed-flag') f.facts.lines[0]!.isExclusiveOrder = 0;
      if (change === 'incomplete')
        Object.assign(f.facts.controls[0]!, { candidateComplete: false });
      await expect(f.seal()).rejects.toMatchObject({
        code: expect.stringMatching(/^ORDER_IMPORT_MEMBERSHIP_/),
      });
    }
  });
  it('keeps candidate SQL read-only, typed, bounded and generation/capture scoped', () => {
    const f = setup(),
      q = csvMembershipCandidateSql(membershipHistoryOptions, membershipCandidateView, f.capture);
    expect(q.statement).toContain('source_capture_hash=@captureHash');
    expect(q.statement).toContain('generation_id=@generation');
    expect(q.statement).toContain('LIMIT @lineTake');
    expect(q.statement).toContain('o.order_status=3');
    expect(q.statement).not.toContain(f.capture.signature);
    expect(q.statement).not.toContain(f.capture.scope.customerId);
    expect(q.statement).not.toContain('AS publications,');
    expect(q.statement).not.toMatch(/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|MERGE|EXPORT|CALL)\b/i);
    expect(q.types).toMatchObject({
      generation: 'STRING',
      snapshot: 'STRING',
      captureHash: 'STRING',
      asOf: 'DATETIME',
      cutoff: 'DATETIME',
    });
    expect(() =>
      csvMembershipCandidateSql(
        membershipHistoryOptions,
        'another-project.dataset.control',
        f.capture,
      ),
    ).toThrow();
  });
  it('enforces the warehouse estimate and total deadline before producing a manifest', async () => {
    const f = setup();
    f.estimate.mockResolvedValue(50000001n);
    await expect(f.seal()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_WAREHOUSE_BUDGET',
    });
    expect(f.execute).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const hung = setup();
    hung.execute.mockImplementation(() => new Promise(() => undefined));
    const result = expect(hung.seal()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_WAREHOUSE_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(8001);
    await result;
  });
  it('refuses stale source captures and a future CDC control instead of minting a fresh snapshot', async () => {
    const f = setup();
    expect(() =>
      verifyCsvMembershipSourceCapture(
        f.capture,
        membershipSourceKey,
        ['10', '12'],
        membershipHistoryNow + 60000,
      ),
    ).toThrow();
    f.facts.controls[0]!.sourceCdcThrough = '2026-11-17T07:30:00Z';
    await expect(f.seal()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID',
    });
  });
  it('rejects oversized decoded row arrays before deep validation and suppresses raw adapters errors', async () => {
    const f = setup();
    Object.assign(f.facts, { orders: Array.from({ length: 1001 }, () => ({})) });
    await expect(f.warehouse.read(f.capture)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_WAREHOUSE_INCOMPLETE',
    });
    const capture = sourceCaptureFixture();
    const task = sealCsvMembershipHistoryPublication(
      capture,
      {
        read: async (_input: CsvMembershipSourceCapture) => {
          throw new Error('PII_CANARY@example.test rawSQL password');
        },
      },
      publicationAuthority,
      { sourceTimeZone: 'Asia/Kolkata', clock: () => membershipHistoryNow },
    );
    await expect(task).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_WAREHOUSE_UNAVAILABLE',
    });
  });
  it('does not assume the fixture warehouse table itself is a publication', () => {
    expect(membershipBigQueryFixture().envelope.publications[0]!.signature).not.toBe(
      sourceCaptureFixture().signature,
    );
  });
  it('canonicalizes genuine UTC-equivalent CDC timestamps for the manifest wire HMAC', async () => {
    const f = setup();
    f.facts.controls[0]!.sourceCdcThrough = '2026-11-17T07:30:02+01:00';
    expect((await f.seal()).publication.sourceCdcThrough).toBe('2026-11-17T06:30:02.000000Z');
  });
  it('refuses genuine sub-microsecond CDC precision instead of silently rounding a seal', async () => {
    const f = setup();
    f.facts.controls[0]!.sourceCdcThrough = '2026-11-17T06:30:02.000000001Z';
    await expect(f.seal()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PUBLICATION_WAREHOUSE_INCOMPLETE',
    });
  });
});
