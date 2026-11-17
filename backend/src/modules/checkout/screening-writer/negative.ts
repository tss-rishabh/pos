import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { CheckoutState } from '../contracts.js';
import { equalImportHash } from '../../legacy-order-imports/financial-adapter-primitives.js';
import {
  nodeScreeningWriterSchema,
  screeningPortableHash,
  screeningQuoteSnapshot,
  type NodeScreeningWriterCapability,
} from './capability.js';
import {
  publicScreeningCreationSchema,
  publicScreeningHash,
  screeningReconciliationRequired,
} from './proof.js';
import type { PublicScreeningOptions } from './options.js';
import { AppError } from '../../../domain/errors.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { randomUUID } from 'node:crypto';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const publicScreeningSubmissionDispatchSchema = z
  .object({
    contract: z.literal('pos-node-screening-submission-dispatch-v1'),
    operationId: z.uuid(),
    requestHash: hash,
    dispatchedAt: z.number().int().positive().safe(),
  })
  .strict();
export const publicScreeningNegativeSchema = z
  .object({
    contract: z.literal('pos-node-screening-no-order-v1'),
    intent: nodeScreeningWriterSchema,
    intentHash: hash,
    dispatchHash: hash,
    source: publicScreeningCreationSchema.shape.source,
    sourceControllerHash: publicScreeningCreationSchema.shape.sourceControllerHash,
    code: z.enum([
      'SCREENING_WRITER_LIMIT',
      'SCREENING_WRITER_QUOTE_CHANGED',
      'SCREENING_WRITER_STOCK_CHANGED',
      'SCREENING_WRITER_LINE_LIMIT',
      'SCREENING_WRITER_EXPIRED',
      'SCREENING_MEMBERSHIP_PROFILE_REQUIRED',
      'SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED',
      'SCREENING_SOURCE_COMMAND_CLOSED',
    ]),
    noOrder: z.literal(true),
    noFinancialEffects: z.literal(true),
    createdAt: z.number().int().positive().safe(),
  })
  .strict()
  .refine((value) => value.createdAt >= value.intent.issuedAt);
export type PublicScreeningNegative = z.infer<typeof publicScreeningNegativeSchema>;
const envelope = z.object({ data: publicScreeningNegativeSchema, proofHash: hash }).strict();
function json(value: unknown): unknown {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  } catch {
    throw screeningReconciliationRequired();
  }
}
function verifiedShape<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw screeningReconciliationRequired();
  return parsed.data;
}

/** Caller owns the actor → Store → checkout → original intent → customer locks. */
export async function readPublicScreeningNegative(
  tx: AdministrationTransaction,
  intent: NodeScreeningWriterCapability,
  key: string,
): Promise<PublicScreeningNegative | null> {
  const [raw] = await tx.execute(sql`SELECT operation_id,checkout_id,request_hash,
    CASE WHEN OCTET_LENGTH(data)<=12000 THEN data ELSE NULL END AS data,proof_hash
    FROM pos_rewrite_public_screening_negatives WHERE operation_id=${intent.operationId} FOR SHARE`);
  const rows = verifiedShape(
    z
      .array(
        z.object({
          operation_id: z.uuid(),
          checkout_id: z.uuid(),
          request_hash: hash,
          data: z.unknown(),
          proof_hash: hash,
        }),
      )
      .max(1),
    raw,
  );
  if (!rows.length) return null;
  const row = rows[0]!,
    value = verifiedShape(publicScreeningNegativeSchema, json(row.data));
  if (
    row.operation_id !== intent.operationId ||
    row.checkout_id !== intent.checkoutId ||
    row.request_hash !== intent.requestHash ||
    screeningPortableHash(value.intent) !== screeningPortableHash(intent) ||
    !equalImportHash(publicScreeningHash(key, 'intent', intent), value.intentHash) ||
    !equalImportHash(publicScreeningHash(key, 'negative', value), row.proof_hash)
  )
    throw screeningReconciliationRequired();
  const [dispatchRows] = await tx.execute(
    sql`SELECT data,proof_hash FROM pos_rewrite_public_screening_submission_dispatches WHERE operation_id=${intent.operationId} FOR SHARE`,
  );
  const dispatchRow = verifiedShape(
    z.array(z.object({ data: z.unknown(), proof_hash: hash })).length(1),
    dispatchRows,
  )[0]!;
  const dispatch = verifiedShape(publicScreeningSubmissionDispatchSchema, json(dispatchRow.data));
  if (
    dispatch.operationId !== intent.operationId ||
    dispatch.requestHash !== intent.requestHash ||
    dispatch.dispatchedAt < intent.issuedAt ||
    dispatch.dispatchedAt >= intent.expiresAt ||
    !equalImportHash(dispatchRow.proof_hash, value.dispatchHash) ||
    !equalImportHash(publicScreeningHash(key, 'submission-dispatch', dispatch), value.dispatchHash)
  )
    throw screeningReconciliationRequired();
  return value;
}

export async function assertNoPublicScreeningEffects(
  tx: AdministrationTransaction,
  intent: NodeScreeningWriterCapability,
  state: CheckoutState,
): Promise<void> {
  if (
    state.orderId ||
    state.orderSubmissionOperationId ||
    state.paymentConfirmation ||
    state.orderCustomerConsent ||
    (state.confirmationPhase !== undefined &&
      state.confirmationPhase !== null &&
      state.confirmationPhase !== 'not-dispatched') ||
    state.confirmationRecovery ||
    state.id !== intent.checkoutId ||
    state.operatorId !== intent.actorId ||
    state.storeId !== intent.storeId ||
    state.counterId !== intent.counterId ||
    (state.customerId ?? state.operatorCustomerId) !== intent.customerId ||
    !state.quote ||
    screeningPortableHash(screeningQuoteSnapshot(state.quote)) !== intent.cartHash
  )
    throw screeningReconciliationRequired();
  const [rawOperation] =
    await tx.execute(sql`SELECT status,result FROM pos_rewrite_checkout_operations
    WHERE checkout_id=${intent.checkoutId} AND id=${intent.operationId} FOR SHARE`);
  const operation = z
    .array(z.object({ status: z.enum(['inflight', 'uncertain', 'rejected']), result: z.null() }))
    .length(1)
    .safeParse(rawOperation);
  if (!operation.success) throw screeningReconciliationRequired();
  // Exact nonce journals, not an inference from a status flag or HTTP failure.
  const tables = [
    'pos_rewrite_public_screening_orders',
    'pos_rewrite_public_screening_effects',
    'pos_rewrite_public_screening_completions',
    'pos_rewrite_public_screening_abandonments',
    'pos_rewrite_public_screening_payment_evidence',
    'pos_rewrite_public_screening_publication_dispatches',
    'pos_rewrite_public_screening_publication_replies',
    'pos_rewrite_import_screening_reservations',
  ];
  if (intent.benefitsContract)
    tables.push(
      'pos_rewrite_public_screening_benefits',
      'pos_rewrite_public_screening_benefit_cache',
    );
  for (const table of tables) {
    const [records] = await tx.execute(
      sql`SELECT operation_id FROM ${sql.identifier(table)} WHERE operation_id=${intent.operationId} LIMIT 1 FOR SHARE`,
    );
    if (!Array.isArray(records) || records.length) throw screeningReconciliationRequired();
  }
  for (const query of [
    sql`SELECT id FROM pos_rewrite_payment_attempts WHERE id=${intent.operationId} LIMIT 1 FOR SHARE`,
    sql`SELECT id FROM pos_rewrite_payment_outbox WHERE id=${intent.operationId} OR id LIKE ${intent.operationId + ':%'} LIMIT 1 FOR SHARE`,
    ...(state.draftId
      ? [
          sql`SELECT id FROM pos_rewrite_offline_cash_receipts WHERE operator_id=${intent.actorId} AND draft_id=${state.draftId} LIMIT 1 FOR SHARE`,
        ]
      : []),
  ]) {
    const [records] = await tx.execute(query);
    if (!Array.isArray(records) || records.length) throw screeningReconciliationRequired();
  }
}

function endpoint(options: PublicScreeningOptions) {
  if (
    options.negativeContract !== 'pos-node-screening-negative-resource-v1' ||
    !options.negativeUrl ||
    !options.negativeKey ||
    !/^[!-~]{32,4096}$/.test(options.negativeKey) ||
    options.negativeKey === options.proofKey ||
    options.negativeKey === options.publicationKey
  )
    throw new AppError(
      503,
      'SCREENING_NEGATIVE_UNAVAILABLE',
      'Source closure is not configured. Keep the original reference.',
    );
  let url: URL;
  try {
    url = new URL(options.negativeUrl);
  } catch {
    throw screeningReconciliationRequired();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/internal/pos/public-screening/no-order-receipts'
  )
    throw screeningReconciliationRequired();
  return url;
}

/** Outside SQL. Its response is only a hint to re-read the native signed row.
 * Neither 404, 2xx, timeout nor this caller's key is no-order authority. */
export async function requestPublicScreeningNegative(
  options: PublicScreeningOptions,
  operationId: string,
): Promise<void> {
  z.uuid().parse(operationId);
  const url = endpoint(options);
  const requestId = currentRequestTrace()?.requestId ?? randomUUID();
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-POS-Public-Screening-Negative-Key': options.negativeKey!,
        'X-Request-ID': requestId,
      },
      body: JSON.stringify({ operationId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    // Bounded validation only. Native proof + native intent/dispatch decide.
    const reader = response.body?.getReader();
    if (!reader) return;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 16000) {
          await reader.cancel();
          return;
        }
        chunks.push(next.value);
      }
      envelope.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    } finally {
      reader.releaseLock();
    }
  } catch {
    // An uncertain private closure can still have committed its exact receipt.
    // Its caller rechecks that row; this catch never asserts a negative result.
  }
}
