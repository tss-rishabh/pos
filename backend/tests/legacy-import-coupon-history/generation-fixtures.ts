import { randomUUID } from 'node:crypto';
import { benefitDigest } from '../../src/modules/legacy-order-imports/benefit-profile/crypto.js';
import { generationControlDataSchema } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-control.js';
import { warehouseFixture, comparison, literalCouponFacts } from './warehouse-fixtures.js';
import {
  generationAccumulator,
  type GenerationRow,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-projections.js';
import {
  generationScopeFor,
  generationSourceContract,
  generationHeadHash,
  generationControlsHash,
  signGenerationCapture,
  verifyGenerationCapture,
  sealGenerationPublication,
  type GenerationFacts,
  type GenerationCapture,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-contracts.js';
import { generationOptionsSchema } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-options.js';
export function generationFixture(empty = false, extraOrderCount = 0) {
  const f = warehouseFixture(empty);
  if (extraOrderCount)
    f.orders = Array.from({ length: extraOrderCount }, (_, i) => ({
      orderId: String(9007199254740992n + BigInt(i)),
      userId: f.scope.customerId,
      couponId: f.scope.couponId,
      status: 1,
      createdAt: f.scope.asOf,
    }));
  const scope = generationScopeFor(f.scope),
    options = generationOptionsSchema.parse({
      contract: 'pos-csv-coupon-generation-runtime-v1',
      sourceOrdersByCustomer: 'tssgcp2025.tss_mysql_raw_layer.tss_orders',
      sourceOrdersByCoupon: 'tssgcp2025.tss_mysql_raw_layer.tss_orders',
      publications: 'tssgcp2025.tss_mysql_raw_layer.fixture_generation_publications',
      candidates: 'tssgcp2025.tss_mysql_raw_layer.fixture_generation_candidates',
      orders: 'tssgcp2025.tss_mysql_raw_layer.fixture_generation_orders',
      logs: 'tssgcp2025.tss_mysql_raw_layer.fixture_generation_logs',
      controls: 'tssgcp2025.tss_mysql_raw_layer.fixture_generation_controls',
      sourceTimeZone: scope.sourceTimeZone,
      comparisonFingerprint: f.controlManifest.comparisonFingerprint,
    });
  const orderRows: GenerationRow[] = f.orders.map((v) => ({
      id: v.orderId,
      userId: v.userId,
      couponId: v.couponId,
      status: v.status,
      createdAt: v.createdAt,
    })),
    logRows: GenerationRow[] = f.logs.map((v) => ({
      id: v.logId,
      userId: v.userId,
      couponId: v.couponId,
      status: v.status,
      createdAt: v.createdAt,
    }));
  const orders = generationAccumulator('order'),
    logs = generationAccumulator('log');
  for (const v of orderRows) orders.add(v);
  for (const v of logRows) logs.add(v);
  const data = generationControlDataSchema.parse({
    contract: 'pos-csv-coupon-generation-controls-v1',
    couponId: scope.couponId,
    configurationHash: scope.configurationHash,
    couponInputHash: 'e'.repeat(64),
    sourceTimeZone: scope.sourceTimeZone,
    sourceDay: scope.sourceDay,
    sourceAsOf: f.scope.asOf,
    serverUuid: f.witness.serverUuid,
    sourceSchema: f.witness.sourceSchema,
    writersContract: f.witness.writersContract,
    writersDefinitionHash: f.witness.writersDefinitionHash,
    heads: f.witness.heads.slice(0, 2),
    observedAt: f.now - 600,
    expiresAt: f.now + 59400,
  });
  const control = {
    data,
    proofHash: benefitDigest('coupon-generation-config', data, f.authority.sourceKey),
  };
  const body: Omit<GenerationCapture, 'signature'> = {
    contract: generationSourceContract,
    sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
    queryContract: 'pos-source-coupon-selects-2960-v1',
    scope,
    control,
    sourceAsOf: f.scope.asOf,
    generationId: f.capture.generationId,
    snapshotId: f.capture.snapshotId,
    ...f.witness,
    headHash: generationHeadHash(scope, f.witness, f.authority.sourceKey),
    capturedAt: f.now - 500,
    finishedAt: f.now - 400,
    couponInputHash: 'e'.repeat(64),
    comparison,
    comparisonFingerprint: options.comparisonFingerprint!,
    controlsCount: String(f.controls.length),
    controlsHash: generationControlsHash(
      scope,
      f.capture.generationId,
      f.capture.snapshotId,
      f.controls,
      f.authority.sourceKey,
    ),
    projections: { orders: orders.finish(), logs: logs.finish() },
    facts: literalCouponFacts(f.scope, f.orders, f.logs, f.controls),
  };
  const capture = verifyGenerationCapture(
    signGenerationCapture(body, f.authority.sourceKey),
    f.authority.sourceKey,
    f.now,
  );
  const facts: GenerationFacts = {
    capture,
    controls: f.controls,
    facts: literalCouponFacts(f.scope, f.orders, f.logs, f.controls),
    projections: structuredClone(capture.projections),
    materializedAt: f.now - 100,
    publication: null,
  };
  const publication = sealGenerationPublication(
    facts,
    f.authority,
    options.comparisonFingerprint!,
    f.now,
  );
  const operation = { ...f.scope, operationId: randomUUID(), asOf: '2026-06-15 12:00:01' };
  function document(mode: 'read' | 'candidate' = 'read') {
    return {
      manifests: [
        {
          contract:
            mode === 'read' ? publication.contract : 'pos-csv-coupon-generation-candidate-v1',
          generationId: capture.generationId,
          snapshotId: capture.snapshotId,
          captureHash: capture.signature,
          headHash: capture.headHash,
          materializedAt: facts.materializedAt,
          captureDocument: JSON.stringify(capture),
          ...(mode === 'read'
            ? { publicationDocument: JSON.stringify(publication) }
            : { candidateComplete: true }),
        },
      ],
      actual: {
        orders: String(f.orders.length),
        uniqueOrders: String(f.orders.length),
        logs: String(f.logs.length),
        uniqueLogs: String(f.logs.length),
        controls: String(f.controls.length),
        uniqueControls: String(f.controls.length),
        invalidOrders: '0',
        invalidLogs: '0',
        invalidControls: '0',
        uncoveredLogs: '0',
        uncoveredOrders: '0',
        lots: String(f.facts.lotCounts.length),
      },
      controls: structuredClone(f.controls),
      facts: literalCouponFacts(f.scope, f.orders, f.logs, f.controls),
      projections: structuredClone(capture.projections),
    };
  }
  return {
    ...f,
    scope,
    options,
    capture,
    control,
    orderRows,
    logRows,
    facts,
    publication,
    operation,
    document,
    rows: (mode: 'read' | 'candidate' = 'read') => [{ document: JSON.stringify(document(mode)) }],
  };
}
