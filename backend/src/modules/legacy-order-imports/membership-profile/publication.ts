import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { operationHash } from '../../checkout/crypto.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';
import {
  csvMembershipHistoryRequestSchema,
  qualifiedCsvMembershipHistorySchema,
  type CsvMembershipHistoryRequest,
} from './history.js';
import {
  csvMembershipPublicationContract,
  csvMembershipPublicationHash,
  csvMembershipPublicationSchema,
  csvMembershipSelectionHash,
  csvMembershipSourceInstant,
  qualifyCsvMembershipWarehouseSnapshot,
  readCsvMembershipBigQueryOptions,
  type CsvMembershipPublication,
  type CsvMembershipSelection,
} from './bigquery.js';

export const csvMembershipSourceCaptureContract = 'pos-csv-membership-source-capture-v1';
export const csvMembershipSourceCommit = '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  count = z.string().regex(/^(0|[1-9]\d{0,18})$/);
export const csvMembershipSelectionSchema = qualifiedCsvMembershipHistorySchema.pick({
  lastDeliveredOrder: true,
  recentDeliveredOrders: true,
});
export const csvMembershipSourceCaptureSchema = z
  .object({
    contract: z.literal(csvMembershipSourceCaptureContract),
    sourceCommit: z.literal(csvMembershipSourceCommit),
    scope: csvMembershipHistoryRequestSchema,
    generationId: hash,
    sourceSnapshotId: z.uuid(),
    sourceTimeZone: z.string().min(1).max(128),
    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    sourceServerUuid: z.uuid(),
    capturedAt: z.number().int().safe().positive(),
    finishedAt: z.number().int().safe().positive(),
    orderCount: count,
    selectedOrderCount: count,
    lineCount: count,
    historyHash: hash,
    selection: csvMembershipSelectionSchema,
    signature: hash,
  })
  .strict();
export type CsvMembershipSourceCapture = z.infer<typeof csvMembershipSourceCaptureSchema>;
export interface CsvMembershipSourceCapturePort {
  capture(
    scope: CsvMembershipHistoryRequest,
    generationId: string,
  ): Promise<CsvMembershipSourceCapture>;
}
export const csvMembershipWarehouseCandidateSchema = z
  .object({
    generationId: hash,
    customerId: csvMembershipHistoryRequestSchema.shape.customerId,
    asOf: csvMembershipHistoryRequestSchema.shape.asOf,
    cutoff: csvMembershipHistoryRequestSchema.shape.cutoff,
    sourceTimeZone: z.string().max(128),
    sourceSnapshotId: z.uuid(),
    sourceCaptureHash: hash,
    sourceCdcThrough: z.iso.datetime({ offset: true }),
    candidateComplete: z.literal(true),
  })
  .strict();
export type CsvMembershipWarehouseCandidate = z.infer<typeof csvMembershipWarehouseCandidateSchema>;
export interface CsvMembershipWarehouseFacts {
  controls: CsvMembershipWarehouseCandidate[];
  actual: {
    orders: string;
    uniqueOrders: string;
    selectedOrders: string;
    uniqueSelectedOrders: string;
    lines: string;
    uniqueLines: string;
    invalidOrders: string;
    latestTies: string;
    foreignLines: string;
  };
  orders: { id: string; paymentMethod: number; createdAt: string }[];
  lines: { orderId: string; lineId: string; productId: string; isExclusiveOrder: 0 | 1 }[];
}
export interface CsvMembershipWarehouseCapturePort {
  read(capture: CsvMembershipSourceCapture): Promise<CsvMembershipWarehouseFacts>;
}
export function parseCsvMembershipWarehouseFacts(
  value: unknown,
  maxOrders = 5000,
  maxLines = 10000,
): CsvMembershipWarehouseFacts {
  const shallow = z
    .object({ controls: z.unknown(), orders: z.unknown(), lines: z.unknown() })
    .safeParse(value);
  if (
    !shallow.success ||
    !Array.isArray(shallow.data.controls) ||
    shallow.data.controls.length !== 1 ||
    !Array.isArray(shallow.data.orders) ||
    shallow.data.orders.length > maxOrders ||
    !Array.isArray(shallow.data.lines) ||
    shallow.data.lines.length > maxLines
  )
    throw membershipPublicationError('WAREHOUSE_INCOMPLETE');
  const id = z.string().regex(/^[1-9]\d{0,18}$/),
    date = csvMembershipHistoryRequestSchema.shape.asOf;
  const schema = z
    .object({
      controls: z.array(csvMembershipWarehouseCandidateSchema).length(1),
      actual: z
        .object({
          orders: count,
          uniqueOrders: count,
          selectedOrders: count,
          uniqueSelectedOrders: count,
          lines: count,
          uniqueLines: count,
          invalidOrders: count,
          latestTies: count,
          foreignLines: count,
        })
        .strict(),
      orders: z
        .array(
          z
            .object({ id, paymentMethod: z.number().int().min(0).max(32767), createdAt: date })
            .strict(),
        )
        .max(maxOrders),
      lines: z
        .array(
          z
            .object({
              orderId: id,
              lineId: id,
              productId: id,
              isExclusiveOrder: z.union([z.literal(0), z.literal(1)]),
            })
            .strict(),
        )
        .max(maxLines),
    })
    .strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw membershipPublicationError('WAREHOUSE_INCOMPLETE');
  return parsed.data;
}
export function membershipPublicationError(kind: string, status = 409) {
  return importFinancialError('ORDER_IMPORT_MEMBERSHIP_PUBLICATION_' + kind, status);
}
function validKey(key: string) {
  if (!/^[!-~]{32,4096}$/.test(key)) throw membershipPublicationError('KEY_REQUIRED', 503);
}
export function csvMembershipSourceCaptureHash(
  value: Omit<CsvMembershipSourceCapture, 'signature'>,
  key: string,
) {
  validKey(key);
  return operationHash('legacy-order-imports.membership-source-capture.v1', value, key);
}
export function validateCsvMembershipSourceSelection(
  selection: unknown,
  scope: CsvMembershipHistoryRequest,
  memberIds: readonly string[],
) {
  let parsed: CsvMembershipSelection;
  try {
    parsed = csvMembershipSelectionSchema.parse(selection);
  } catch {
    throw membershipPublicationError('SOURCE_INVALID');
  }
  const recent = parsed.recentDeliveredOrders,
    last = parsed.lastDeliveredOrder,
    members = new Set(memberIds);
  if (
    new Set(recent.map((row) => row.id)).size !== recent.length ||
    recent.some(
      (row, index) =>
        row.createdAt <= scope.cutoff ||
        row.createdAt > scope.asOf ||
        (index > 0 && recent[index - 1]!.createdAt <= row.createdAt),
    ) ||
    (recent.length && JSON.stringify(last) !== JSON.stringify(recent[0])) ||
    (last && last.createdAt > scope.cutoff && !recent.length)
  )
    throw membershipPublicationError('SOURCE_INVALID');
  let lines = 0;
  for (const row of [...(last ? [last] : []), ...recent]) {
    lines += row.lines.length;
    if (
      !/^[1-9]\d{0,18}$/.test(row.id) ||
      BigInt(row.id) > 9223372036854775807n ||
      row.createdAt > scope.asOf ||
      row.createdAt.startsWith('0000-') ||
      new Set(row.lines.map((line) => line.lineId)).size !== row.lines.length ||
      new Set(
        row.lines
          .filter((line) => !members.has(line.productId))
          .map((line) => line.isExclusiveOrder),
      ).size > 1 ||
      row.lines.some(
        (line) =>
          !['lineId', 'productId'].every((name) => {
            const value = name === 'lineId' ? line.lineId : line.productId;
            return /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
          }),
      )
    )
      throw membershipPublicationError('SOURCE_AMBIGUOUS');
  }
  if (lines > 20000 || Buffer.byteLength(JSON.stringify(parsed)) > 990000)
    throw membershipPublicationError('SOURCE_TOO_LARGE');
  return parsed;
}
export function verifyCsvMembershipSourceCapture(
  value: unknown,
  key: string,
  memberIds: readonly string[],
  now = Date.now(),
) {
  validKey(key);
  // Count nested work before parsing. Only server/source captures belong here;
  // neither a browser body nor an arbitrary complete:true assertion is proof.
  const shallow = z
    .object({
      selection: z.object({
        lastDeliveredOrder: z.unknown(),
        recentDeliveredOrders: z.array(z.unknown()).max(5000),
      }),
    })
    .safeParse(value);
  if (!shallow.success) throw membershipPublicationError('SOURCE_INVALID');
  let lineCount = 0;
  for (const row of [
    shallow.data.selection.lastDeliveredOrder,
    ...shallow.data.selection.recentDeliveredOrders,
  ]) {
    if (row === null) continue;
    if (!row || typeof row !== 'object' || !('lines' in row) || !Array.isArray(row.lines))
      throw membershipPublicationError('SOURCE_INVALID');
    lineCount += row.lines.length;
    if (lineCount > 20000) throw membershipPublicationError('SOURCE_TOO_LARGE');
  }
  let parsed: CsvMembershipSourceCapture;
  try {
    parsed = csvMembershipSourceCaptureSchema.parse(value);
  } catch {
    throw membershipPublicationError('SOURCE_INVALID');
  }
  const { signature, ...body } = parsed,
    point = csvMembershipSourceInstant(parsed.scope.asOf, parsed.sourceTimeZone);
  if (
    !Number.isSafeInteger(now) ||
    !equalImportHash(signature, csvMembershipSourceCaptureHash(body, key)) ||
    parsed.capturedAt < point ||
    parsed.capturedAt - point >= 1000 ||
    parsed.finishedAt < parsed.capturedAt ||
    parsed.finishedAt > now ||
    now - point >= 60000
  )
    throw membershipPublicationError('SOURCE_INVALID');
  const selection = validateCsvMembershipSourceSelection(parsed.selection, parsed.scope, memberIds),
    unique = [
      ...new Map(
        [
          ...(selection.lastDeliveredOrder ? [selection.lastDeliveredOrder] : []),
          ...selection.recentDeliveredOrders,
        ].map((row) => [row.id, row]),
      ).values(),
    ];
  if (
    BigInt(parsed.selectedOrderCount) !== BigInt(unique.length) ||
    BigInt(parsed.lineCount) !==
      BigInt(unique.reduce((total, row) => total + row.lines.length, 0)) ||
    BigInt(parsed.orderCount) < BigInt(parsed.selectedOrderCount) ||
    (parsed.orderCount === '0' ? unique.length !== 0 : unique.length === 0) ||
    csvMembershipSelectionHash(parsed.scope, selection) !== parsed.historyHash
  )
    throw membershipPublicationError('SOURCE_INVALID');
  return parsed;
}
/** The sealer consumes a *real independently queried* warehouse envelope. It
 * never promotes source rows to BQ history or publishes a source-only boolean. */
export async function sealCsvMembershipHistoryPublication(
  supplied: unknown,
  warehouse: CsvMembershipWarehouseCapturePort,
  authority: {
    sourceKey: string;
    publicationKey: string;
    historyKey: string;
    memberProductIds: readonly string[];
  },
  options: { sourceTimeZone: string; clock?: () => number },
): Promise<{ publication: CsvMembershipPublication; capture: CsvMembershipSourceCapture }> {
  const clock = options.clock ?? Date.now,
    capture = verifyCsvMembershipSourceCapture(
      supplied,
      authority.sourceKey,
      authority.memberProductIds,
      clock(),
    );
  validKey(authority.publicationKey);
  validKey(authority.historyKey);
  if (
    new Set([authority.sourceKey, authority.publicationKey, authority.historyKey]).size !== 3 ||
    options.sourceTimeZone !== capture.sourceTimeZone
  )
    throw membershipPublicationError('CONFIGURATION', 503);
  let facts: CsvMembershipWarehouseFacts;
  try {
    facts = parseCsvMembershipWarehouseFacts(await warehouse.read(capture));
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('ORDER_IMPORT_MEMBERSHIP_')) throw error;
    throw membershipPublicationError('WAREHOUSE_UNAVAILABLE', 503);
  }
  const now = clock();
  if (facts.controls.length !== 1) throw membershipPublicationError('WAREHOUSE_INCOMPLETE');
  const parsed = csvMembershipWarehouseCandidateSchema.safeParse(facts.controls[0]);
  if (!parsed.success) throw membershipPublicationError('WAREHOUSE_INCOMPLETE');
  const control = parsed.data;
  if (
    control.generationId !== capture.generationId ||
    control.customerId !== capture.scope.customerId ||
    control.asOf !== capture.scope.asOf ||
    control.cutoff !== capture.scope.cutoff ||
    control.sourceTimeZone !== capture.sourceTimeZone ||
    control.sourceSnapshotId !== capture.sourceSnapshotId ||
    control.sourceCaptureHash !== capture.signature
  )
    throw membershipPublicationError('WAREHOUSE_SCOPE_CHANGED');
  verifyCsvMembershipSourceCapture(capture, authority.sourceKey, authority.memberProductIds, now);
  const point = csvMembershipSourceInstant(capture.scope.asOf, capture.sourceTimeZone),
    time = (value: number) =>
      Temporal.Instant.fromEpochMilliseconds(value).toString({ smallestUnit: 'microsecond' });
  const cdc = Temporal.Instant.from(control.sourceCdcThrough);
  if (cdc.epochNanoseconds % 1000n !== 0n) throw membershipPublicationError('WAREHOUSE_INCOMPLETE');
  const warehouseLines = new Map<string, typeof facts.lines>();
  for (const row of facts.lines) {
    const entries = warehouseLines.get(row.orderId) ?? [];
    entries.push(row);
    warehouseLines.set(row.orderId, entries);
  }
  const warehouseOrders = facts.orders.map((row) => ({
    ...row,
    lines: (warehouseLines.get(row.id) ?? [])
      .sort((left, right) => (BigInt(left.lineId) < BigInt(right.lineId) ? -1 : 1))
      .map(({ orderId: _order, ...line }) => line),
  }));
  const warehouseHistoryHash = csvMembershipSelectionHash(capture.scope, {
    lastDeliveredOrder: warehouseOrders[0] ?? null,
    recentDeliveredOrders: warehouseOrders.filter((row) => row.createdAt > capture.scope.cutoff),
  });
  const body: Omit<CsvMembershipPublication, 'signature'> = {
    contract: csvMembershipPublicationContract,
    generationId: capture.generationId,
    customerId: capture.scope.customerId,
    asOf: capture.scope.asOf,
    cutoff: capture.scope.cutoff,
    sourceTimeZone: capture.sourceTimeZone,
    sourceSnapshotId: capture.sourceSnapshotId,
    sourceSnapshotAt: time(point),
    sourceCdcThrough: cdc.toString({ smallestUnit: 'microsecond' }),
    publishedAt: time(now),
    sourceComplete: true,
    sourceOrderCount: capture.orderCount,
    warehouseOrderCount: facts.actual.orders,
    sourceSelectedOrderCount: capture.selectedOrderCount,
    warehouseSelectedOrderCount: facts.actual.selectedOrders,
    sourceLineCount: capture.lineCount,
    warehouseLineCount: facts.actual.lines,
    sourceHistoryHash: capture.historyHash,
    warehouseHistoryHash,
  };
  const parsedPublication = csvMembershipPublicationSchema.safeParse({
    ...body,
    signature: csvMembershipPublicationHash(body, authority.publicationKey),
  });
  if (!parsedPublication.success) throw membershipPublicationError('WAREHOUSE_INCOMPLETE');
  const publication = parsedPublication.data;
  // Reuse the reader's whole count/row/hash/time/ambiguity validator. The
  // provisional manifest never leaves this function before validation succeeds.
  qualifyCsvMembershipWarehouseSnapshot(
    [
      {
        document: JSON.stringify({
          publications: [publication],
          actual: facts.actual,
          orders: facts.orders,
          lines: facts.lines,
        }),
      },
    ],
    capture.scope,
    readCsvMembershipBigQueryOptions({
      CSV_MEMBERSHIP_SOURCE_TIMEZONE: capture.sourceTimeZone,
      CSV_MEMBERSHIP_MAX_ORDERS: '5000',
    }),
    authority,
    { started: now, now },
  );
  return { publication, capture };
}
