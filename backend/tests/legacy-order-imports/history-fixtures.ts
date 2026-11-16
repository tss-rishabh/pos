import {
  legacyOrderImportHistoryHashes,
  orderImportHistoryContract,
  type LegacyOrderImportHistoryAnchor,
  type LegacyOrderImportHistoricalResult,
  type LegacyOrderImportHistoryOptions,
} from '../../src/modules/legacy-order-imports/history.js';
export const historyNow = Date.parse('2026-11-17T10:00:00Z');
export const historyOptions: LegacyOrderImportHistoryOptions = {
  ORDER_IMPORT_HISTORY_CONTRACT: orderImportHistoryContract,
  BQ_ORDER_IMPORT_JOBS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.pos_order_import_jobs_v1',
  BQ_ORDER_IMPORT_RESULTS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.pos_order_import_results_v1',
  BQ_ORDER_IMPORT_PUBLICATIONS_VIEW:
    'tssgcp2025.tss_mysql_raw_layer.pos_order_import_publications_v1',
};
export function importHistoryFixture() {
  const anchor: LegacyOrderImportHistoryAnchor = {
    job: {
      sequence: 18446744073709551615n,
      id: '123e4567-e89b-42d3-a456-426614174000',
      actorId: '9007199254740993',
      requestHash: 'a'.repeat(64),
      kind: 'offline',
      state: 'CANCELLED',
      totalOrders: 3,
      importedOrders: 1,
      failedOrders: 1,
      cancelledOrders: 1,
      errorCode: null,
      createdAt: '2026-11-01 10:00:00.123',
      updatedAt: '2026-11-01 10:03:00.456',
      completedAt: '2026-11-01 10:03:00.456',
    },
    scopes: [
      { storeId: '1', counterId: '2' },
      { storeId: '10', counterId: '20' },
    ],
  };
  const rows: LegacyOrderImportHistoricalResult[] = [
    {
      sequence: 1,
      firstRow: 2,
      operationId: '123e4567-e89b-42d3-a456-426614174001',
      storeId: '1',
      counterId: '2',
      state: 'IMPORTED',
      orderId: '9007199254740995',
      receiptId: '123e4567-e89b-42d3-a456-426614174011',
      businessDate: '2025-10-01',
      errorCode: null,
      updatedAt: '2026-11-01 10:01:00.123',
    },
    {
      sequence: 2,
      firstRow: 4,
      operationId: '123e4567-e89b-42d3-a456-426614174002',
      storeId: '10',
      counterId: '20',
      state: 'FAILED',
      orderId: null,
      receiptId: null,
      businessDate: null,
      errorCode: 'ORDER_IMPORT_SOURCE_REJECTED',
      updatedAt: '2026-11-01 10:02:00.123',
    },
    {
      sequence: 3,
      firstRow: 7,
      operationId: '123e4567-e89b-42d3-a456-426614174003',
      storeId: '1',
      counterId: '2',
      state: 'CANCELLED',
      orderId: null,
      receiptId: null,
      businessDate: null,
      errorCode: null,
      updatedAt: '2026-11-01 10:03:00.456',
    },
  ];
  return { anchor, rows };
}
export function importHistorySnapshot(
  anchor: LegacyOrderImportHistoryAnchor,
  rows: readonly LegacyOrderImportHistoricalResult[],
  after = 0,
  limit = 50,
) {
  const hashes = legacyOrderImportHistoryHashes(anchor, rows),
    generationId = '123e4567-e89b-42d3-a456-426614174100',
    j = anchor.job;
  return {
    publications: [
      {
        generationId,
        contract: orderImportHistoryContract,
        jobId: j.id,
        actorId: j.actorId,
        requestHash: j.requestHash,
        sourceComplete: true,
        sourceSnapshotId: 'complete-source-snapshot-fixture-1',
        sourceSnapshotAt: '2026-11-01T10:03:01.000000Z',
        sourceCdcWatermark: '2026-11-01T10:03:02.000000Z',
        publishedAt: '2026-11-01T10:03:03.000000Z',
        sourceRows: String(j.totalOrders),
        warehouseRows: String(j.totalOrders),
        sourceJobHash: hashes.jobHash,
        warehouseJobHash: hashes.jobHash,
        sourceResultHash: hashes.resultHash,
        warehouseResultHash: hashes.resultHash,
      },
    ],
    jobs: [{ ...j, sequence: j.sequence.toString(), generationId, computedHash: hashes.jobHash }],
    stats: {
      recordCount: String(rows.length),
      distinctSequences: String(new Set(rows.map((row) => row.sequence)).size),
      distinctFirstRows: String(new Set(rows.map((row) => row.firstRow)).size),
      distinctOperations: String(new Set(rows.map((row) => row.operationId)).size),
      distinctOrders: String(
        new Set(rows.flatMap((row) => (row.orderId ? [row.orderId] : []))).size,
      ),
      distinctReceipts: String(
        new Set(rows.flatMap((row) => (row.receiptId ? [row.receiptId] : []))).size,
      ),
      minimumSequence: rows.length ? String(Math.min(...rows.map((row) => row.sequence))) : null,
      maximumSequence: rows.length ? String(Math.max(...rows.map((row) => row.sequence))) : null,
      importedCount: String(rows.filter((row) => row.state === 'IMPORTED').length),
      failedCount: String(rows.filter((row) => row.state === 'FAILED').length),
      cancelledCount: String(rows.filter((row) => row.state === 'CANCELLED').length),
      invalidCount: '0',
      computedHash: hashes.resultHash,
    },
    scopes: [...anchor.scopes],
    page: rows
      .map((row, index) => ({ ...row, rowHash: hashes.rowHashes[index]! }))
      .filter((row) => row.sequence > after)
      .slice(0, limit),
  };
}
