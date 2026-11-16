import { and, asc, eq, gt, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { HasProduct, Order, OrderStore } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { cashDigest, verifiedCashImportProof } from './crypto.js';
import {
  cashHash,
  cashSignature,
  cashTimestamp,
  devicePublicKeySchema,
  signedCashReceiptSchema,
} from './contracts.js';
import type { CashImportProofData } from './import-proof-contracts.js';
import {
  offlineCashImportProofs as proofs,
  offlineCashOrderLinks as links,
  offlineCashReceipts as receipts,
  offlineCashSigningKeys as signingKeys,
} from './schema.js';

type ReadExecutor = Pick<ReturnType<Databases['get']>, 'select'>;
export interface OfflineCashImportScope {
  storeIds: readonly string[];
  from: string;
  to: string;
  receiptIds?: readonly string[];
}
export interface VerifiedOfflineCashImport {
  receiptId: string;
  orderId: string;
  storeId: string;
  counterId: string;
  businessDate: string;
  payableCents: number;
  finalizedAt: number;
}
const maxCandidates = 70000,
  maxProofBytes = 2_000_000,
  maxReceiptBytes = 262144,
  maxBatchBytes = 16_000_000,
  maxBodyBatch = 100,
  maxStructureLines = 20000;
const invalid = () =>
  new AppError(
    503,
    'OFFLINE_CASH_IMPORT_PROOF_INVALID',
    'Offline cash import evidence requires reconciliation before calculating financial totals.',
  );
const missing = () =>
  new AppError(
    503,
    'OFFLINE_CASH_IMPORT_PROOF_REQUIRED',
    'Offline cash import evidence must be verified before calculating financial totals.',
  );
const tooLarge = () =>
  new AppError(
    422,
    'OFFLINE_CASH_IMPORT_PROOF_TOO_LARGE',
    'Select fewer stores or a smaller financial range to verify offline cash import evidence.',
  );
const cents = z
  .string()
  .regex(/^\d{1,13}$/)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value <= 1_000_000_000_000);
const candidateSchema = z.object({
  receiptId: z.uuid(),
  status: z.literal('imported'),
  orderId: identifier,
  storeId: identifier,
  counterId: identifier,
  operatorId: identifier,
  authorizationId: z.uuid(),
  requestHash: cashHash,
  receiptNumber: z.string(),
  businessDate: z.iso.date(),
  payableCents: cents,
  cashReceivedCents: cents,
  changeCents: cents,
  acceptedAt: cashTimestamp,
  receiptBytes: z.number().int().positive().max(maxReceiptBytes),
  linkReceiptId: z.uuid(),
  linkOrderId: identifier,
  linkPayableCents: cents,
  linkBusinessDate: z.iso.date(),
  projectionHash: cashHash,
  finalizedAt: cashTimestamp,
  proofReceiptId: z.uuid(),
  proofOrderId: identifier,
  keyId: cashHash,
  signature: cashSignature,
  proofCreatedAt: cashTimestamp,
  proofBytes: z.number().int().positive().max(maxProofBytes),
});
type Candidate = z.infer<typeof candidateSchema>;
const fields = {
  receiptId: receipts.id,
  status: receipts.status,
  orderId: receipts.orderId,
  storeId: receipts.storeId,
  counterId: receipts.counterId,
  operatorId: receipts.operatorId,
  authorizationId: receipts.authorizationId,
  requestHash: receipts.requestHash,
  receiptNumber: receipts.receiptNumber,
  businessDate: receipts.businessDate,
  payableCents: sql<string>`cast(${receipts.payableCents} as char)`,
  cashReceivedCents: sql<string>`cast(${receipts.cashReceivedCents} as char)`,
  changeCents: sql<string>`cast(${receipts.changeCents} as char)`,
  acceptedAt: receipts.acceptedAt,
  receiptBytes: sql<number>`octet_length(${receipts.envelope})`.mapWith(Number),
  linkReceiptId: links.receiptId,
  linkOrderId: links.orderId,
  linkPayableCents: sql<string>`cast(${links.payableCents} as char)`,
  linkBusinessDate: links.businessDate,
  projectionHash: links.projectionHash,
  finalizedAt: links.finalizedAt,
  proofReceiptId: proofs.receiptId,
  proofOrderId: proofs.orderId,
  keyId: proofs.keyId,
  signature: proofs.signature,
  proofCreatedAt: proofs.createdAt,
  proofBytes: sql<number>`octet_length(${proofs.proof})`.mapWith(Number),
};
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalid();
  }
}
function validateBinding(
  row: Candidate,
  proof: CashImportProofData,
  envelope: z.infer<typeof signedCashReceiptSchema>,
) {
  const receipt = envelope.receipt;
  if (
    row.receiptId !== row.linkReceiptId ||
    row.receiptId !== row.proofReceiptId ||
    row.receiptId !== proof.receiptId ||
    row.receiptId !== receipt.id ||
    row.orderId !== row.linkOrderId ||
    row.orderId !== row.proofOrderId ||
    row.orderId !== proof.orderId ||
    row.authorizationId !== proof.authorizationId ||
    row.authorizationId !== receipt.authorizationId ||
    row.operatorId !== proof.operatorId ||
    row.operatorId !== receipt.operatorId ||
    row.storeId !== proof.storeId ||
    row.storeId !== receipt.storeId ||
    row.counterId !== proof.counterId ||
    row.counterId !== receipt.counterId ||
    row.businessDate !== row.linkBusinessDate ||
    row.businessDate !== proof.businessDate ||
    row.businessDate !== receipt.businessDate ||
    row.receiptNumber !== proof.receiptNumber ||
    row.receiptNumber !== receipt.receiptNumber ||
    row.payableCents !== row.linkPayableCents ||
    row.payableCents !== proof.payableCents ||
    row.payableCents !== receipt.payableCents ||
    row.cashReceivedCents !== proof.cashReceivedCents ||
    row.cashReceivedCents !== receipt.cashReceivedCents ||
    row.changeCents !== proof.changeCents ||
    row.changeCents !== receipt.changeCents ||
    row.finalizedAt !== row.proofCreatedAt ||
    row.finalizedAt !== proof.finalizedAt ||
    row.finalizedAt < row.acceptedAt ||
    row.projectionHash !== proof.headerHash ||
    row.requestHash !== proof.receiptHash ||
    cashDigest(envelope) !== row.requestHash
  )
    throw invalid();
  const sourceQuantities = new Map<string, number>(),
    sealedQuantities = new Map<string, number>();
  for (const line of receipt.lines) {
    if (sourceQuantities.has(line.productId)) throw invalid();
    sourceQuantities.set(line.productId, line.quantity);
  }
  for (const line of proof.lines)
    sealedQuantities.set(
      line.productId,
      (sealedQuantities.get(line.productId) || 0) + line.quantity,
    );
  if (
    sourceQuantities.size !== sealedQuantities.size ||
    [...sourceQuantities].some(([id, quantity]) => sealedQuantities.get(id) !== quantity)
  )
    throw invalid();
}
async function assertStructure(executor: ReadExecutor, items: readonly CashImportProofData[]) {
  if (!items.length) return;
  const ids = items.map((item) => BigInt(item.orderId)),
    expectedLines = items.reduce((total, item) => total + item.lines.length, 0);
  const orders = await executor
    .select({ id: Order.id, customerId: Order.user })
    .from(Order)
    .where(inArray(Order.id, ids));
  const stores = await executor
    .select({ orderId: OrderStore.order, storeId: OrderStore.store, counterId: OrderStore.counter })
    .from(OrderStore)
    .where(inArray(OrderStore.order, ids))
    .orderBy(asc(OrderStore.id))
    .limit(items.length + 1);
  const lines = await executor
    .select({
      id: HasProduct.id,
      orderId: HasProduct.order,
      productId: HasProduct.product,
      subProductId: HasProduct.sub_prod_id,
      quantity: HasProduct.qty,
    })
    .from(HasProduct)
    .where(inArray(HasProduct.order, ids))
    .orderBy(asc(HasProduct.id))
    .limit(expectedLines + 1);
  if (
    orders.length !== items.length ||
    stores.length !== items.length ||
    lines.length !== expectedLines
  )
    throw invalid();
  const orderMap = new Map(orders.map((order) => [String(order.id), order])),
    storeMap = new Map<string, typeof stores>();
  for (const row of stores) {
    const id = String(row.orderId),
      list = storeMap.get(id) || [];
    list.push(row);
    storeMap.set(id, list);
  }
  const lineMap = new Map(lines.map((line) => [String(line.id), line]));
  for (const item of items) {
    const order = orderMap.get(item.orderId),
      storeRows = storeMap.get(item.orderId),
      store = storeRows?.[0];
    if (
      !order ||
      String(order.customerId) !== item.customerId ||
      storeRows?.length !== 1 ||
      !store ||
      String(store.storeId) !== item.storeId ||
      String(store.counterId) !== item.counterId
    )
      throw invalid();
    for (const expected of item.lines) {
      const line = lineMap.get(expected.hasProductId);
      if (
        !line ||
        String(line.orderId) !== item.orderId ||
        String(line.productId) !== expected.productId ||
        line.subProductId !== 0n ||
        line.quantity !== BigInt(expected.quantity)
      )
        throw invalid();
    }
  }
}

async function verifyCandidates(
  executor: ReadExecutor,
  ordered: Candidate[],
): Promise<VerifiedOfflineCashImport[]> {
  const verified: VerifiedOfflineCashImport[] = [];
  let offset = 0;
  while (offset < ordered.length) {
    const batch: Candidate[] = [];
    let bytes = 0;
    while (offset < ordered.length && batch.length < maxBodyBatch) {
      const row = ordered[offset]!;
      const next = row.proofBytes + row.receiptBytes;
      if (batch.length && bytes + next > maxBatchBytes) break;
      batch.push(row);
      bytes += next;
      offset++;
    }
    const receiptIds = batch.map((row) => row.receiptId),
      keyIds = [...new Set(batch.map((row) => row.keyId))];
    const bodyRows = await executor
      .select({ id: receipts.id, envelope: receipts.envelope })
      .from(receipts)
      .where(inArray(receipts.id, receiptIds));
    const proofRows = await executor
      .select({ id: proofs.receiptId, body: proofs.proof })
      .from(proofs)
      .where(inArray(proofs.receiptId, receiptIds));
    const keyRows = await executor
      .select({ id: signingKeys.keyId, publicKey: signingKeys.publicKey })
      .from(signingKeys)
      .where(inArray(signingKeys.keyId, keyIds));
    const bodies = new Map(bodyRows.map((row) => [row.id, row.envelope])),
      proofBodies = new Map(proofRows.map((row) => [row.id, row.body])),
      keys = new Map(keyRows.map((row) => [row.id, row.publicKey]));
    let structural: CashImportProofData[] = [],
      lineCount = 0;
    for (const row of batch) {
      const body = bodies.get(row.receiptId),
        proofBody = proofBodies.get(row.receiptId),
        keyBody = keys.get(row.keyId);
      if (
        !body ||
        !proofBody ||
        !keyBody ||
        Buffer.byteLength(body, 'utf8') > maxReceiptBytes ||
        Buffer.byteLength(proofBody, 'utf8') > maxProofBytes ||
        Buffer.byteLength(keyBody, 'utf8') > 512
      )
        throw missing();
      const key = devicePublicKeySchema.safeParse(parseJson(keyBody));
      if (!key.success) throw invalid();
      const signed = verifiedCashImportProof(key.data, {
          proof: parseJson(proofBody),
          keyId: row.keyId,
          signature: row.signature,
        }),
        envelope = signedCashReceiptSchema.safeParse(parseJson(body));
      if (!signed || !envelope.success) throw invalid();
      const proof = signed.proof;
      validateBinding(row, proof, envelope.data);
      if (structural.length && lineCount + proof.lines.length > maxStructureLines) {
        await assertStructure(executor, structural);
        structural = [];
        lineCount = 0;
      }
      structural.push(proof);
      lineCount += proof.lines.length;
      verified.push({
        receiptId: row.receiptId,
        orderId: row.orderId,
        storeId: row.storeId,
        counterId: row.counterId,
        businessDate: row.businessDate,
        payableCents: row.payableCents,
        finalizedAt: row.finalizedAt,
      });
    }
    await assertStructure(executor, structural);
  }
  return verified;
}

/**
 * Use the same repeatable-read transaction as financial aggregation. Historic
 * keys/seals retain cash after revocation, price, status and stock changes.
 * Keyset metadata pages and byte-limited body batches bound memory; no raw
 * receipt, proof, key or database error enters a log.
 */
export async function assertOfflineCashImportProofs(
  executor: ReadExecutor,
  scope: OfflineCashImportScope,
): Promise<VerifiedOfflineCashImport[]> {
  const storeIds = [...new Set(scope.storeIds.map((store) => identifier.parse(store)))],
    from = z.iso.date().parse(scope.from),
    to = z.iso.date().parse(scope.to),
    receiptIds =
      scope.receiptIds === undefined
        ? undefined
        : z
            .array(z.uuid())
            .min(1)
            .max(1000)
            .refine((ids) => new Set(ids).size === ids.length, 'Receipt IDs must be unique.')
            .parse(scope.receiptIds);
  if (from > to)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'The To date is before the From date.');
  if (!storeIds.length) return [];
  const end = Temporal.PlainDate.from(to).add({ days: 1 }).toString(),
    seen = new Set<string>(),
    verified: VerifiedOfflineCashImport[] = [];
  async function consume(values: readonly unknown[]) {
    const candidates: Candidate[] = [];
    let last: Candidate | undefined;
    for (const value of values) {
      const parsed = candidateSchema.safeParse(value);
      if (!parsed.success) throw missing();
      const row = parsed.data;
      last = row;
      if (seen.has(row.receiptId)) continue;
      seen.add(row.receiptId);
      if (seen.size > maxCandidates) throw tooLarge();
      candidates.push(row);
    }
    verified.push(...(await verifyCandidates(executor, candidates)));
    return last;
  }
  // The receipt index covers store/date/id; use its complete lexical key.
  let cursor: Pick<Candidate, 'storeId' | 'businessDate' | 'receiptId'> | undefined;
  for (;;) {
    const page = await executor
      .select(fields)
      .from(receipts)
      .leftJoin(links, eq(links.receiptId, receipts.id))
      .leftJoin(proofs, eq(proofs.receiptId, receipts.id))
      .where(
        and(
          inArray(receipts.storeId, storeIds),
          receiptIds ? inArray(receipts.id, receiptIds) : undefined,
          gte(receipts.businessDate, from),
          lt(receipts.businessDate, end),
          or(
            eq(receipts.status, 'imported'),
            isNotNull(links.receiptId),
            isNotNull(proofs.receiptId),
          ),
          cursor
            ? or(
                gt(receipts.storeId, cursor.storeId),
                and(
                  eq(receipts.storeId, cursor.storeId),
                  gt(receipts.businessDate, cursor.businessDate),
                ),
                and(
                  eq(receipts.storeId, cursor.storeId),
                  eq(receipts.businessDate, cursor.businessDate),
                  gt(receipts.id, cursor.receiptId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(receipts.storeId), asc(receipts.businessDate), asc(receipts.id))
      .limit(250);
    if (!page.length) break;
    cursor = await consume(page);
    if (page.length < 250) break;
  }
  // Independently inspect ordinary orders in the requested date range. A
  // mismatched receipt date must not bypass proof validation and erase cash.
  let lastOrderId: bigint | undefined;
  for (;;) {
    const page = await executor
      .select({ ...fields, sourceOrderId: Order.id })
      .from(OrderStore)
      .innerJoin(Order, eq(Order.id, OrderStore.order))
      .innerJoin(links, eq(links.orderId, sql`cast(${Order.id} as char)`))
      .leftJoin(receipts, eq(receipts.id, links.receiptId))
      .leftJoin(proofs, eq(proofs.receiptId, links.receiptId))
      .where(
        and(
          inArray(OrderStore.store, storeIds.map(BigInt)),
          receiptIds ? inArray(links.receiptId, receiptIds) : undefined,
          gte(Order.created_at, from + ' 00:00:00'),
          lt(Order.created_at, end + ' 00:00:00'),
          lastOrderId === undefined ? undefined : gt(Order.id, lastOrderId),
        ),
      )
      .orderBy(asc(Order.id))
      .limit(250);
    if (!page.length) break;
    await consume(page);
    lastOrderId = page.at(-1)!.sourceOrderId;
    if (page.length < 250) break;
  }
  return verified;
}
