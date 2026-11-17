import {
  csvMembershipBigQueryContract,
  csvMembershipPublicationContract,
  csvMembershipPublicationHash,
  csvMembershipSelectionHash,
  readCsvMembershipBigQueryOptions,
  type CsvMembershipPublication,
  type CsvMembershipSelection,
} from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import {
  csvMembershipHistoryContract,
  type CsvMembershipHistoryRequest,
} from '../../src/modules/legacy-order-imports/membership-profile/history.js';

export const membershipHistoryKey = 'synthetic-membership-history-only-'.repeat(2);
export const membershipPublicationKey = 'synthetic-source-publisher-only-'.repeat(2);
export const membershipHistoryNow = Date.parse('2026-11-17T06:30:03.000Z');
export const membershipHistoryOptions = readCsvMembershipBigQueryOptions({
  CSV_MEMBERSHIP_BIGQUERY_CONTRACT: csvMembershipBigQueryContract,
  BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW:
    'tssgcp2025.tss_mysql_raw_layer.fixture_membership_publications',
  BQ_CSV_MEMBERSHIP_ORDERS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.fixture_membership_orders',
  BQ_CSV_MEMBERSHIP_LINES_VIEW: 'tssgcp2025.tss_mysql_raw_layer.fixture_membership_lines',
  CSV_MEMBERSHIP_SOURCE_TIMEZONE: 'Asia/Kolkata',
});
export const membershipHistoryScope: CsvMembershipHistoryRequest = {
  contract: csvMembershipHistoryContract,
  operationId: 'c25ed89e-021a-4dfe-8848-a579f7f2d997',
  requestHash: 'a'.repeat(64),
  planHash: 'b'.repeat(64),
  customerId: '9007199254740993',
  asOf: '2026-11-17 12:00:00',
  cutoff: '2026-10-03 12:00:00',
};
export const membershipHistoryAuthority = {
  historyKey: membershipHistoryKey,
  publicationKey: membershipPublicationKey,
  memberProductIds: ['10', '12'],
};
export interface MembershipFixtureOrder {
  id: string;
  customerId: string;
  paymentMethod: number;
  orderStatus: number;
  paymentStatus: number;
  createdAt: string;
  lines: { lineId: string; productId: string; isExclusiveOrder: 0 | 1 }[];
}
export function membershipFixtureOrder(
  overrides: Partial<MembershipFixtureOrder> = {},
): MembershipFixtureOrder {
  return {
    id: '9007199254741001',
    customerId: membershipHistoryScope.customerId,
    paymentMethod: 14,
    orderStatus: 3,
    paymentStatus: 0,
    createdAt: '2026-11-17 11:59:59',
    lines: [{ lineId: '9007199254741002', productId: '11', isExclusiveOrder: 1 }],
    ...overrides,
  };
}
export function membershipBigQueryFixture(
  all = [
    membershipFixtureOrder(),
    membershipFixtureOrder({ id: '9007199254741003', createdAt: '2026-10-04 00:00:00', lines: [] }),
    membershipFixtureOrder({ id: '9007199254741004', createdAt: '2026-01-01 00:00:00', lines: [] }),
  ],
  scope = membershipHistoryScope,
) {
  const delivered = all
    .filter((row) => row.customerId === scope.customerId && row.orderStatus === 3)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const convert = (row: MembershipFixtureOrder) => ({
    id: row.id,
    paymentMethod: row.paymentMethod,
    createdAt: row.createdAt,
    lines: [...row.lines].sort((a, b) => (BigInt(a.lineId) < BigInt(b.lineId) ? -1 : 1)),
  });
  const selection: CsvMembershipSelection = {
    lastDeliveredOrder: delivered[0] ? convert(delivered[0]) : null,
    recentDeliveredOrders: delivered.filter((row) => row.createdAt > scope.cutoff).map(convert),
  };
  const selected = delivered.filter(
    (row) => row.createdAt > scope.cutoff || row.id === delivered[0]?.id,
  );
  const orders = selected.map(({ id, paymentMethod, createdAt }) => ({
    id,
    paymentMethod,
    createdAt,
  }));
  const lines = selected.flatMap((row) => row.lines.map((line) => ({ orderId: row.id, ...line })));
  const sourceHash = csvMembershipSelectionHash(scope, selection);
  const body: Omit<CsvMembershipPublication, 'signature'> = {
    contract: csvMembershipPublicationContract,
    generationId: 'c'.repeat(64),
    customerId: scope.customerId,
    asOf: scope.asOf,
    cutoff: scope.cutoff,
    sourceTimeZone: 'Asia/Kolkata',
    sourceSnapshotId: 'membership-fixture-source-2026',
    sourceSnapshotAt: '2026-11-17T06:30:00.000000Z',
    sourceCdcThrough: '2026-11-17T06:30:01.000000Z',
    publishedAt: '2026-11-17T06:30:02.000000Z',
    sourceComplete: true,
    sourceOrderCount: String(delivered.length),
    warehouseOrderCount: String(delivered.length),
    sourceSelectedOrderCount: String(orders.length),
    warehouseSelectedOrderCount: String(orders.length),
    sourceLineCount: String(lines.length),
    warehouseLineCount: String(lines.length),
    sourceHistoryHash: sourceHash,
    warehouseHistoryHash: sourceHash,
  };
  return {
    all,
    selection,
    envelope: {
      publications: [
        { ...body, signature: csvMembershipPublicationHash(body, membershipPublicationKey) },
      ],
      actual: {
        orders: String(delivered.length),
        uniqueOrders: String(new Set(delivered.map((row) => row.id)).size),
        selectedOrders: String(orders.length),
        uniqueSelectedOrders: String(new Set(orders.map((row) => row.id)).size),
        lines: String(lines.length),
        uniqueLines: String(new Set(lines.map((row) => row.lineId)).size),
        invalidOrders: '0',
        latestTies: delivered.length ? '1' : '0',
        foreignLines: '0',
      },
      orders,
      lines,
    },
  };
}
export function resealMembershipPublication(value: CsvMembershipPublication) {
  const { signature: _signature, ...body } = value;
  value.signature = csvMembershipPublicationHash(body, membershipPublicationKey);
}
