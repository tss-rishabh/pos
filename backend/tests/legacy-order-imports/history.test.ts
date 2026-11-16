import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  legacyOrderImportHistory,
  legacyOrderImportHistoryHashes,
  legacyOrderImportHistorySql,
  readLegacyOrderImportHistoryOptions,
  type LegacyOrderImportHistoryAnchor,
} from '../../src/modules/legacy-order-imports/history.js';
import {
  historyNow,
  historyOptions,
  importHistoryFixture,
  importHistorySnapshot,
} from './history-fixtures.js';
const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'import-history-fixture-'.repeat(4),
  BIGQUERY_PROJECT_ID: 'tssgcp2025',
});
function setup() {
  const { anchor, rows } = importHistoryFixture(),
    queryReport = vi.fn(async (_sql: string, params: Record<string, unknown>) => [
      {
        snapshot: JSON.stringify(
          importHistorySnapshot(anchor, rows, Number(params.after), Number(params.limit)),
        ),
      },
    ]);
  return {
    anchor,
    rows,
    queryReport,
    read: legacyOrderImportHistory(config, historyOptions, { queryReport }, () => historyNow),
  };
}
describe('immutable terminal order import publication reader', () => {
  it('uses a single bounded read-only query and preserves exact private-anchor IDs without returning private metadata', async () => {
    const f = setup(),
      job = await f.read.detail(f.anchor),
      page = await f.read.results(f.anchor, 0, 2);
    const {
      sequence: _sequence,
      actorId: _actorId,
      requestHash: _requestHash,
      ...expected
    } = f.anchor.job;
    expect(job).toEqual(expected);
    expect(page).toEqual(f.rows.slice(0, 2));
    expect(page[0]!.orderId).toBe('9007199254740995');
    expect(Object.keys(job).sort()).toEqual(
      [
        'cancelledOrders',
        'completedAt',
        'createdAt',
        'errorCode',
        'failedOrders',
        'id',
        'importedOrders',
        'kind',
        'state',
        'totalOrders',
        'updatedAt',
      ].sort(),
    );
    for (const row of page)
      expect(Object.keys(row).sort()).toEqual(
        [
          'sequence',
          'firstRow',
          'operationId',
          'storeId',
          'counterId',
          'state',
          'orderId',
          'receiptId',
          'businessDate',
          'errorCode',
          'updatedAt',
        ].sort(),
      );
    const [statement, params] = f.queryReport.mock.calls[1]!;
    expect(statement).toBe(legacyOrderImportHistorySql(historyOptions));
    expect(statement).toContain('STRING_AGG(row_hash');
    expect(statement).toContain('r.sequence>@after');
    expect(statement).toContain('LIMIT @limit');
    expect(statement).not.toContain(f.anchor.job.id);
    expect(statement).not.toMatch(
      /\b(?:payload|reference|email|name|address|message|proof_hash)\b/i,
    );
    expect(params).toMatchObject({
      jobId: f.anchor.job.id,
      actorId: f.anchor.job.actorId,
      requestHash: f.anchor.job.requestHash,
      after: 0,
      limit: 2,
      createdAt: '2026-11-01T10:00:00.123Z',
    });
    expect(f.queryReport).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ createdAt: 'TIMESTAMP', after: 'INT64', limit: 'INT64' }),
      'order-import-history',
    );
    expect(f.queryReport).toHaveBeenCalledTimes(2);
  });
  it('accepts a full native job anchor while stripping private fields from all outputs', async () => {
    const f = setup(),
      job = {
        ...f.anchor.job,
        requestId: 'PRIVATE_REQUEST',
        claimToken: 'PRIVATE_CLAIM',
        leaseUntil: null,
      },
      anchor = { job, scopes: f.anchor.scopes };
    const result = await f.read.detail(anchor);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain(f.anchor.job.requestHash);
    expect(serialized).not.toContain(f.anchor.job.actorId);
  });
  it('provides contiguous ascending keyset pages and verifies a legitimate empty tail rather than inventing empty first results', async () => {
    const f = setup();
    expect(await f.read.results(f.anchor, 2, 2)).toEqual(f.rows.slice(2));
    expect(await f.read.results(f.anchor, 3, 2)).toEqual([]);
    expect(await f.read.results(f.anchor, 50000, 100)).toEqual([]);
    const snapshot = importHistorySnapshot(f.anchor, f.rows, 0, 2);
    snapshot.page = [];
    f.queryReport.mockResolvedValue([{ snapshot: JSON.stringify(snapshot) }]);
    await expect(f.read.results(f.anchor, 0, 2)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_HISTORY_INVALID',
    });
  });
  it('refuses missing deployment inputs without dispatch and never imports a MySQL fallback', async () => {
    const f = setup();
    for (const options of [
      {},
      { ...historyOptions, ORDER_IMPORT_HISTORY_CONTRACT: 'unapproved' },
      { ...historyOptions, BQ_ORDER_IMPORT_RESULTS_VIEW: undefined },
    ])
      await expect(
        legacyOrderImportHistory(
          config,
          options,
          { queryReport: f.queryReport },
          () => historyNow,
        ).detail(f.anchor),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_HISTORY_REQUIRED' });
    expect(f.queryReport).not.toHaveBeenCalled();
    expect(() =>
      readLegacyOrderImportHistoryOptions({
        BQ_ORDER_IMPORT_JOBS_VIEW: 'project.dataset.table; DELETE FROM secrets',
      }),
    ).toThrow();
    expect(
      readLegacyOrderImportHistoryOptions({ BQ_ORDER_IMPORT_JOBS_VIEW: '' })
        .BQ_ORDER_IMPORT_JOBS_VIEW,
    ).toBeUndefined();
  });
  it('rejects active/inconsistent/current-day anchors and unsafe page inputs before query execution', async () => {
    const f = setup();
    for (const patch of [
      { state: 'RUNNING' as const },
      { completedAt: null },
      { totalOrders: 4 },
      { sequence: 0n },
      { requestHash: 'invalid' },
      { updatedAt: '2026-11-01 09:00:00.000' },
      { completedAt: '2026-11-17 09:00:00.000', updatedAt: '2026-11-17 09:00:00.000' },
      { completedAt: '2026-11-16 10:00:00.000', updatedAt: '2026-11-16 10:00:00.000' },
    ])
      await expect(
        f.read.detail({ ...f.anchor, job: { ...f.anchor.job, ...patch } }),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_HISTORY_INVALID' });
    for (const [after, limit] of [
      [-1, 1],
      [50001, 1],
      [0, 0],
      [0, 101],
      [1.5, 50],
      [Number.POSITIVE_INFINITY, 50],
    ])
      await expect(f.read.results(f.anchor, after, limit)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_PAGE_INVALID',
      });
    expect(f.queryReport).not.toHaveBeenCalled();
  });
  it('requires one exact generation, source completeness and independent job/result hash conservation', async () => {
    const f = setup(),
      mutations: ((snapshot: ReturnType<typeof importHistorySnapshot>) => void)[] = [
        (s) => {
          s.publications = [];
        },
        (s) => {
          s.publications.push({ ...s.publications[0]! });
        },
        (s) => {
          s.publications[0]!.sourceComplete = false;
        },
        (s) => {
          s.publications[0]!.actorId = '88';
        },
        (s) => {
          s.publications[0]!.requestHash = 'b'.repeat(64);
        },
        (s) => {
          s.publications[0]!.sourceRows = '0';
        },
        (s) => {
          s.publications[0]!.warehouseRows = '2';
        },
        (s) => {
          s.publications[0]!.sourceJobHash = 'b'.repeat(64);
        },
        (s) => {
          s.publications[0]!.warehouseResultHash = 'b'.repeat(64);
        },
        (s) => {
          s.publications[0]!.sourceResultHash = 'b'.repeat(64);
          s.publications[0]!.warehouseResultHash = 'b'.repeat(64);
        },
        (s) => {
          s.jobs = [];
        },
        (s) => {
          s.jobs.push({ ...s.jobs[0]! });
        },
        (s) => {
          s.jobs[0]!.actorId = '88';
        },
        (s) => {
          s.jobs[0]!.computedHash = 'b'.repeat(64);
        },
        (s) => {
          s.jobs[0]!.sequence = '9007199254740992';
        },
        (s) => {
          s.jobs[0]!.generationId = '123e4567-e89b-42d3-a456-426614174101';
        },
        (s) => {
          s.jobs[0]!.updatedAt = '2026-11-01 10:03:00.457';
        },
      ];
    for (const mutate of mutations) {
      const value = importHistorySnapshot(f.anchor, f.rows, 0, 2);
      mutate(value);
      f.queryReport.mockResolvedValue([{ snapshot: JSON.stringify(value) }]);
      await expect(f.read.results(f.anchor, 0, 2)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_HISTORY_INVALID',
      });
    }
  });
  it('verifies completion checkpoint and CDC ordering without requiring recurring fresh publication of an immutable old job', async () => {
    const f = setup();
    expect((await f.read.detail(f.anchor)).completedAt).toBe(f.anchor.job.completedAt);
    for (const patch of [
      { sourceSnapshotAt: '2026-11-01T10:03:00.455Z' },
      { sourceCdcWatermark: '2026-11-01T10:03:00.456Z' },
      { publishedAt: '2026-11-01T10:03:01Z' },
      { publishedAt: '2026-11-17T10:00:06Z' },
      { sourceSnapshotId: 'unknown' },
    ]) {
      const value = importHistorySnapshot(f.anchor, f.rows, 0, 2);
      Object.assign(value.publications[0]!, patch);
      f.queryReport.mockResolvedValue([{ snapshot: JSON.stringify(value) }]);
      await expect(f.read.results(f.anchor, 0, 2)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_HISTORY_INVALID',
      });
    }
  });
  it('rejects missing/duplicate/nonterminal rows anywhere in the full published result set', async () => {
    const f = setup();
    for (const patch of [
      { recordCount: '2' },
      { distinctSequences: '2' },
      { distinctFirstRows: '2' },
      { distinctOperations: '2' },
      { distinctOrders: '0' },
      { distinctReceipts: '0' },
      { minimumSequence: '2' },
      { maximumSequence: '4' },
      { importedCount: '0' },
      { failedCount: '0' },
      { cancelledCount: '0' },
      { invalidCount: '1' },
      { computedHash: 'b'.repeat(64) },
    ]) {
      const value = importHistorySnapshot(f.anchor, f.rows, 0, 2);
      Object.assign(value.stats, patch);
      f.queryReport.mockResolvedValue([{ snapshot: JSON.stringify(value) }]);
      await expect(f.read.results(f.anchor, 0, 2)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_HISTORY_INVALID',
      });
    }
  });
  it('checks the complete scope set and page row hash; private/raw fields cannot escape the public result shape', async () => {
    const f = setup(),
      mutations: ((snapshot: ReturnType<typeof importHistorySnapshot>) => void)[] = [
        (s) => {
          s.scopes = [{ storeId: '2', counterId: '2' }];
        },
        (s) => {
          s.scopes.push({ ...s.scopes[0]! });
        },
        (s) => {
          s.page[0]!.orderId = '8';
        },
        (s) => {
          s.page[0]!.counterId = '3';
        },
        (s) => {
          s.page[0]!.sequence = 2;
        },
        (s) => {
          s.page[0]!.updatedAt = '2026-11-01 10:04:00.000';
        },
        (s) => {
          s.page[0]!.receiptId = null;
        },
        (s) => {
          Object.assign(s.page[0]!, {
            payload: 'ENCRYPTED',
            email: 'fixture@example.test',
            reference: 'PRIVATE',
          });
        },
      ];
    for (const mutate of mutations) {
      const value = importHistorySnapshot(f.anchor, f.rows, 0, 2);
      mutate(value);
      f.queryReport.mockResolvedValue([{ snapshot: JSON.stringify(value) }]);
      await expect(f.read.results(f.anchor, 0, 2)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_HISTORY_INVALID',
      });
    }
  });
  it('preserves all terminal job-state count branches and source backdated business dates', async () => {
    for (const state of ['COMPLETED', 'FAILED', 'PARTIAL', 'CANCELLED'] as const) {
      const base = importHistoryFixture(),
        rows = base.rows.slice(0, state === 'PARTIAL' ? 2 : 1),
        anchor: LegacyOrderImportHistoryAnchor = {
          ...base.anchor,
          job: {
            ...base.anchor.job,
            state,
            totalOrders: rows.length,
            importedOrders: state === 'COMPLETED' ? 1 : state === 'PARTIAL' ? 1 : 0,
            failedOrders: state === 'FAILED' ? 1 : state === 'PARTIAL' ? 1 : 0,
            cancelledOrders: state === 'CANCELLED' ? 1 : 0,
          },
          scopes: state === 'PARTIAL' ? base.anchor.scopes : base.anchor.scopes.slice(0, 1),
        };
      if (state === 'FAILED')
        rows[0] = { ...base.rows[1]!, sequence: 1, storeId: '1', counterId: '2' };
      if (state === 'CANCELLED') rows[0] = { ...base.rows[2]!, sequence: 1 };
      const queryReport = vi.fn(async (_sql: string, params: Record<string, unknown>) => [
          {
            snapshot: JSON.stringify(
              importHistorySnapshot(anchor, rows, Number(params.after), Number(params.limit)),
            ),
          },
        ]),
        read = legacyOrderImportHistory(config, historyOptions, { queryReport }, () => historyNow);
      expect((await read.detail(anchor)).state).toBe(state);
      expect(await read.results(anchor)).toEqual(rows);
    }
    const f = setup();
    expect((await f.read.results(f.anchor))[0]!.businessDate).toBe('2025-10-01');
  });
  it('keeps canonical hashes order-independent by numeric sequence and sensitive to every public field', () => {
    const f = importHistoryFixture(),
      hashes = legacyOrderImportHistoryHashes(f.anchor, f.rows);
    expect(legacyOrderImportHistoryHashes(f.anchor, [...f.rows].reverse())).toEqual(hashes);
    expect(hashes.rowHashes).toHaveLength(3);
    const changed = [{ ...f.rows[0]!, orderId: '8' }, ...f.rows.slice(1)];
    expect(legacyOrderImportHistoryHashes(f.anchor, changed).resultHash).not.toBe(
      hashes.resultHash,
    );
    expect(
      legacyOrderImportHistoryHashes(
        { ...f.anchor, job: { ...f.anchor.job, requestHash: 'b'.repeat(64) } },
        f.rows,
      ).jobHash,
    ).not.toBe(hashes.jobHash);
  });
  it('fails closed on unavailable/malformed warehouse responses rather than returning zero or exposing errors', async () => {
    const f = setup();
    for (const raw of [
      [],
      [{ snapshot: 'not json' }],
      [{ snapshot: '{}' }],
      [{ snapshot: JSON.stringify({ unexpected: 'PRIVATE' }) }],
      [{ snapshot: 'x'.repeat(150001) }],
    ]) {
      f.queryReport.mockResolvedValue(raw);
      await expect(f.read.detail(f.anchor)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_HISTORY_INVALID',
      });
    }
    f.queryReport.mockRejectedValue(new Error('controlled upstream unavailable'));
    await expect(f.read.detail(f.anchor)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_HISTORY_UNAVAILABLE',
      message: 'Historical import results are temporarily unavailable.',
    });
  });
});
