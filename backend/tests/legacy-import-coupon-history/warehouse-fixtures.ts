import { Temporal } from '@js-temporal/polyfill';
import { publicationFixture } from './fixtures.js';
import {
  couponControlHeadHash,
  couponFactsHash,
  couponSourceCaptureHash,
  sealCouponHistoryPublication,
  type CouponPublicationFacts,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-publication.js';
import {
  couponBigQueryOptionsSchema,
  couponBigQueryContract,
  couponComparisonFingerprint,
  sealCouponWarehouseControls,
  type CouponWarehouseControlRow,
  type CouponComparison,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-contracts.js';
import { couponHistoryWitnessSchema } from '../../src/modules/legacy-order-imports/benefit-profile/bridge.js';
import type { CouponHistoryScope } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
export interface PrimitiveOrder {
  orderId: string;
  userId: string | null;
  couponId: string | null;
  status: number | null;
  createdAt: string | null;
}
export interface PrimitiveLog {
  logId: string;
  userId: string;
  couponId: string | null;
  status: number | null;
  createdAt: string | null;
}
export const comparison: CouponComparison = {
  contract: 'pos-native-coupon-comparisons-v1',
  lot: {
    column: 'coupon_lot_no',
    dataType: 'varchar',
    characterSet: 'latin1',
    collation: 'latin1_swedish_ci',
    padAttribute: 'PAD SPACE',
  },
  code: {
    column: 'voucher_code',
    dataType: 'varchar',
    characterSet: 'latin1',
    collation: 'latin1_swedish_ci',
    padAttribute: 'PAD SPACE',
  },
  lotComparison: 'native-column-equality-and-nonempty',
  codeComparison: 'python-decoded-exact-utf8',
};
/** Literal row-loop oracle, deliberately independent from warehouse grouped SQL.
 * order_id on the source log is never the join key. */
export function literalCouponFacts(
  scope: CouponHistoryScope,
  orders: readonly PrimitiveOrder[],
  logs: readonly PrimitiveLog[],
  controls: readonly CouponWarehouseControlRow[],
): CouponPublicationFacts {
  const point = Temporal.PlainDateTime.from(scope.asOf.replace(' ', 'T')),
    day = point.toPlainDate().toString(),
    month = day.slice(0, 7);
  const eligible = (order: PrimitiveOrder) =>
    order.status !== null && ![0, 17].includes(order.status);
  const joined = (couponId: string) =>
    logs.flatMap((log) =>
      log.userId === scope.customerId && log.couponId === couponId && log.status === 1
        ? orders
            .filter(
              (order) =>
                eligible(order) && order.userId === log.userId && order.couponId === log.couponId,
            )
            .map((order) => ({ order, log }))
        : [],
    );
  return {
    globalUsage: String(
      orders.filter(
        (order) =>
          order.status !== null &&
          ![0, 4, 7, 15, 17, 22, 31, 33].includes(order.status) &&
          order.couponId === scope.couponId,
      ).length,
    ),
    birthdayTodayUsage: String(
      orders.filter(
        (order) =>
          eligible(order) &&
          order.userId === scope.customerId &&
          order.couponId === scope.couponId &&
          order.createdAt?.slice(0, 10) === day,
      ).length,
    ),
    customerOrderCount: String(
      orders.filter((order) => eligible(order) && order.userId === scope.customerId).length,
    ),
    monthlyJoinedUsage: String(
      joined(scope.couponId).filter(({ log }) => log.createdAt?.slice(0, 7) === month).length,
    ),
    lotCounts: controls
      .filter(
        (control) => control.present && control.lotMatches && joined(control.couponId).length > 0,
      )
      .map((control) => ({
        couponId: control.couponId,
        sameCode: control.sameCode,
        noTimesAllowed: control.noTimesAllowed!,
        uniqueNoTimesAllowed: control.uniqueNoTimesAllowed!,
        usedCount: String(joined(control.couponId).length),
      }))
      .sort((a, b) => (BigInt(a.couponId) < BigInt(b.couponId) ? -1 : 1)),
  };
}
export function warehouseFixture(empty = false) {
  const base = publicationFixture(empty),
    u = base.scope.customerId;
  const orders: PrimitiveOrder[] = empty
    ? []
    : [
        { orderId: '1', userId: u, couponId: '222', status: 1, createdAt: '2026-06-15 12:00:00' },
        { orderId: '2', userId: u, couponId: '222', status: 4, createdAt: '2026-06-15 23:59:00' },
        { orderId: '3', userId: u, couponId: '222', status: 6, createdAt: '2014-01-01 00:00:00' },
        { orderId: '4', userId: u, couponId: '223', status: 1, createdAt: '2035-01-01 00:00:00' },
        {
          orderId: '5',
          userId: '88',
          couponId: '222',
          status: 1,
          createdAt: '2035-01-01 00:00:00',
        },
        { orderId: '6', userId: u, couponId: '0', status: 1, createdAt: '2015-01-01 00:00:00' },
        { orderId: '7', userId: u, couponId: '222', status: 0, createdAt: base.scope.asOf },
        { orderId: '8', userId: u, couponId: '222', status: 17, createdAt: base.scope.asOf },
        { orderId: '9', userId: u, couponId: '222', status: null, createdAt: null },
        { orderId: '10', userId: u, couponId: '222', status: 7, createdAt: base.scope.asOf },
      ];
  const log = (logId: string, couponId: string, date: string, status = 1): PrimitiveLog => ({
    logId,
    userId: u,
    couponId,
    status,
    createdAt: date,
  });
  const logs: PrimitiveLog[] = empty
    ? []
    : [
        log('101', '222', '2026-06-01 00:00:00'),
        log('102', '222', '2026-06-30 23:59:00'),
        log('103', '222', base.scope.asOf),
        log('104', '222', '2010-01-01 00:00:00'),
        log('105', '223', '2035-01-01 00:00:00'),
        log('106', '999', base.scope.asOf),
        log('107', '0', base.scope.asOf),
        log('108', '222', base.scope.asOf, 0),
      ];
  const controls: CouponWarehouseControlRow[] = [
    ...(empty
      ? []
      : [
          {
            couponId: '0',
            present: false,
            lotMatches: false,
            sameCode: false,
            noTimesAllowed: null,
            uniqueNoTimesAllowed: null,
          },
        ]),
    {
      couponId: '222',
      present: true,
      lotMatches: true,
      sameCode: true,
      noTimesAllowed: '1000',
      uniqueNoTimesAllowed: '10',
    },
    ...(empty
      ? []
      : [
          {
            couponId: '223',
            present: true,
            lotMatches: true,
            sameCode: false,
            noTimesAllowed: '1000',
            uniqueNoTimesAllowed: '11',
          },
          {
            couponId: '999',
            present: false,
            lotMatches: false,
            sameCode: false,
            noTimesAllowed: null,
            uniqueNoTimesAllowed: null,
          },
        ]),
  ];
  const facts = literalCouponFacts(base.scope, orders, logs, controls),
    { signature: _signature, ...body } = base.capture;
  body.facts = facts;
  body.factsHash = couponFactsHash(base.scope, facts, base.authority.sourceKey);
  body.controlHeadHash = couponControlHeadHash(body, base.authority.sourceKey);
  const capture = { ...body, signature: couponSourceCaptureHash(body, base.authority.sourceKey) };
  const controlManifest = sealCouponWarehouseControls(
    capture,
    comparison,
    controls,
    base.authority.sourceKey,
    base.now,
  );
  const options = couponBigQueryOptionsSchema.parse({
    CSV_COUPON_BIGQUERY_CONTRACT: couponBigQueryContract,
    CSV_COUPON_SOURCE_TIMEZONE: 'Asia/Kolkata',
    CSV_COUPON_COMPARISON_FINGERPRINT: couponComparisonFingerprint(comparison),
    BQ_CSV_COUPON_PUBLICATIONS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.fixture_coupon_publications',
    BQ_CSV_COUPON_CANDIDATES_VIEW: 'tssgcp2025.tss_mysql_raw_layer.fixture_coupon_candidates',
    BQ_CSV_COUPON_ORDERS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.fixture_coupon_orders',
    BQ_CSV_COUPON_LOGS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.fixture_coupon_logs',
    BQ_CSV_COUPON_CONTROLS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.fixture_coupon_controls',
  });
  const warehouse = {
    generationId: capture.generationId,
    snapshotId: capture.snapshotId,
    sourceCaptureHash: capture.signature,
    controlHeadHash: capture.controlHeadHash,
    sourceCdcThrough: base.now,
    facts: literalCouponFacts(base.scope, orders, logs, controls),
  };
  const publication = sealCouponHistoryPublication(capture, warehouse, base.authority, base.now);
  const witness = couponHistoryWitnessSchema.parse({
    writersContract: capture.writersContract,
    writersDefinitionHash: capture.writersDefinitionHash,
    serverUuid: capture.serverUuid,
    sourceSchema: capture.sourceSchema,
    heads: capture.heads,
  });
  function document(mode: 'read' | 'candidate' = 'read') {
    return {
      manifests: [
        {
          contract:
            mode === 'read' ? publication.contract : 'pos-csv-coupon-warehouse-candidate-v1',
          generationId: capture.generationId,
          snapshotId: capture.snapshotId,
          sourceCaptureHash: capture.signature,
          controlHeadHash: capture.controlHeadHash,
          sourceCdcThrough: base.now,
          sourceCaptureDocument: JSON.stringify(capture),
          controlDocument: JSON.stringify(controlManifest),
          ...(mode === 'read'
            ? { publicationDocument: JSON.stringify(publication) }
            : { candidateComplete: true }),
        },
      ],
      actual: {
        orders: String(orders.length),
        uniqueOrders: String(orders.length),
        logs: String(logs.length),
        uniqueLogs: String(logs.length),
        controls: String(controls.length),
        uniqueControls: String(controls.length),
        invalidOrders: '0',
        invalidLogs: '0',
        invalidControls: '0',
        uncoveredLogs: '0',
        uncoveredOrders: '0',
        lots: String(facts.lotCounts.length),
      },
      controls: structuredClone(controls),
      facts: literalCouponFacts(base.scope, orders, logs, controls),
    };
  }
  return {
    ...base,
    options,
    capture,
    witness,
    controls,
    controlManifest,
    publication,
    warehouse,
    orders,
    logs,
    facts,
    document,
    rows: (mode: 'read' | 'candidate' = 'read') => [{ document: JSON.stringify(document(mode)) }],
  };
}
