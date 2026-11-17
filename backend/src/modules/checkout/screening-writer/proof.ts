import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';
import { equalImportHash } from '../../legacy-order-imports/financial-adapter-crypto.js';
import { operationHash } from '../crypto.js';
import {
  screeningReservationSchema,
  screeningSource,
} from '../../legacy-order-imports/screening-profile.js';
import { customerContactBindingSchema } from '../customer-contact-authority.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const publicScreeningCreationSchema = z
  .object({
    contract: z.literal('pos-node-screening-creation-v1'),
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    checkoutVersion: z.number().int().nonnegative().safe(),
    actorId: identifier,
    customerId: identifier,
    storeId: identifier,
    counterId: identifier,
    requestHash: hash,
    cartHash: hash,
    actorVersion: hash,
    actorEpoch: customerContactBindingSchema.shape.revision,
    contact: customerContactBindingSchema,
    source: z
      .object({
        apiCommit: z.literal(screeningSource.apiCommit),
        helperHash: z.literal(screeningSource.helperHash),
        controllerHash: z.literal(screeningSource.controllerHash),
        modelHash: z.literal(screeningSource.modelHash),
      })
      .strict(),
    sourceControllerHash: z.literal(
      'd8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18',
    ),
    orderId: identifier,
    method: z.union([z.literal(3), z.literal(14)]),
    lineItemsEnabled: z.boolean(),
    lines: screeningReservationSchema.shape.lines,
    markers: screeningReservationSchema.shape.markers,
    effectsHash: hash,
    createdAt: z.number().int().positive().safe(),
  })
  .strict();
export type PublicScreeningCreation = z.infer<typeof publicScreeningCreationSchema>;
export const screeningReconciliationRequired = () =>
  new AppError(
    409,
    'SCREENING_WRITER_RECONCILIATION_REQUIRED',
    'The original screening order needs reconciliation.',
  );
export function publicScreeningHash(
  key: string,
  purpose:
    | 'creation'
    | 'plan'
    | 'authority'
    | 'abandonment'
    | 'completion'
    | 'intent'
    | 'payment-intent'
    | 'payment-paid'
    | 'publication'
    | 'publication-dispatch'
    | 'submission-dispatch',
  value: unknown,
) {
  if (!/^[!-~]{32,4096}$/.test(key)) throw screeningReconciliationRequired();
  return operationHash(
    'legacy-order-imports.source.public-screening-' + purpose + '.v1',
    value,
    key,
  );
}
function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
export async function readPublicScreeningCreation(
  tx: AdministrationTransaction,
  operationId: string,
  key: string,
): Promise<PublicScreeningCreation | null> {
  z.uuid().parse(operationId);
  const [raw] =
    await tx.execute(sql`SELECT operation_id,checkout_id,actor_id,customer_id,store_id,counter_id,order_id,request_hash,
    CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END AS data,proof_hash
    FROM pos_rewrite_public_screening_orders WHERE operation_id=${operationId} FOR SHARE`);
  const records = z
    .array(
      z.object({
        operation_id: z.uuid(),
        checkout_id: z.uuid(),
        actor_id: identifier,
        customer_id: identifier,
        store_id: identifier,
        counter_id: identifier,
        order_id: identifier,
        request_hash: hash,
        data: z.unknown(),
        proof_hash: hash,
      }),
    )
    .max(1)
    .parse(raw);
  if (!records.length) return null;
  const row = records[0]!,
    value = publicScreeningCreationSchema.parse(parsedJson(row.data));
  if (
    value.operationId !== row.operation_id ||
    value.checkoutId !== row.checkout_id ||
    value.actorId !== row.actor_id ||
    value.customerId !== row.customer_id ||
    value.storeId !== row.store_id ||
    value.counterId !== row.counter_id ||
    value.orderId !== row.order_id ||
    value.requestHash !== row.request_hash ||
    !equalImportHash(publicScreeningHash(key, 'creation', value), row.proof_hash)
  )
    throw screeningReconciliationRequired();
  return value;
}

/** Call under the native Order lock before a NEW charge/confirmation. No bypass ID. */
export async function assertPublicScreeningOrderAvailable(
  tx: AdministrationTransaction,
  orderId: string,
): Promise<void> {
  identifier.parse(orderId);
  const [rows] = await tx.execute(
    sql`SELECT operation_id FROM pos_rewrite_public_screening_abandonments WHERE order_id=${orderId} LIMIT 1 FOR SHARE`,
  );
  if (
    z
      .array(z.object({ operation_id: z.uuid() }))
      .max(1)
      .parse(rows).length
  )
    throw new AppError(
      409,
      'SCREENING_ORDER_ABANDONED',
      'This unpaid screening order was fenced and cannot accept payment.',
    );
}
