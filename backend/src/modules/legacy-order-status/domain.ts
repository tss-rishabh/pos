import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
export const wholeOrderStatusContract = 'pos-whole-order-status-v1';
export const statusCapabilitySchema = z
  .object({
    contract: z.literal(wholeOrderStatusContract),
    profile: z.literal('pinned-store-chain-v1'),
    sourcePin: z.literal('70b80159016db39a73572f80bfa87c47201c0a9f'),
    operationId: z.uuid(),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    challenge: z.uuid(),
  })
  .strict();
export const statusCapabilitySignature = (
  secret: string,
  value: z.infer<typeof statusCapabilitySchema>,
) =>
  createHmac('sha256', secret)
    .update(
      'pos-whole-order-status-capability-v1\0' +
        JSON.stringify(statusCapabilitySchema.parse(value)),
    )
    .digest('base64url');
export const platform = z.enum(['PACK', 'SHIP', 'DELIVER']);
export type StatusPlatform = z.infer<typeof platform>;
export const commandInput = z
  .object({ operationId: z.uuid(), platform, scopeHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const scopeSnapshot = z
  .object({
    orderId: identifier,
    customerId: z
      .string()
      .regex(/^(0|[1-9]\d{0,18})$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
    storeId: identifier,
    counterId: identifier,
    reference: z.string().max(255),
    locationCode: z.string().min(1).max(255),
    storeRowIds: z.array(identifier).min(1).max(1000),
    lines: z
      .array(
        z
          .object({
            id: identifier,
            productId: identifier,
            subProductId: z.string().regex(/^(0|[1-9]\d{0,18})$/),
            quantity: z.string().regex(/^(0|[1-9]\d{0,18})$/),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.storeRowIds).size !== value.storeRowIds.length ||
      new Set(value.lines.map((row) => row.id)).size !== value.lines.length
    )
      ctx.addIssue({ code: 'custom', message: 'Order scope rows must be unique.' });
  });
export type StatusSnapshot = z.infer<typeof scopeSnapshot>;
export const statusDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const immutableScopeHash = (snapshot: StatusSnapshot) =>
  statusDigest(scopeSnapshot.parse(snapshot));
export function sourceStatusBody(snapshot: StatusSnapshot, stage: StatusPlatform) {
  return {
    orderId: snapshot.orderId,
    has_product_ids: snapshot.lines.map((line) => line.id),
    platform: stage,
  };
}
export function requiredStages(stage: StatusPlatform): StatusPlatform[] {
  return stage === 'PACK'
    ? ['PACK', 'SHIP', 'DELIVER']
    : stage === 'SHIP'
      ? ['SHIP', 'DELIVER']
      : ['DELIVER'];
}
export const receiptSchema = z
  .object({
    contract: z.literal(wholeOrderStatusContract),
    operationId: z.uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['queued', 'succeeded', 'rejected', 'unknown']),
    acceptedAt: z.iso.datetime({ offset: true }).nullable(),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    taskId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .nullable(),
    stages: z
      .array(
        z
          .object({
            platform,
            status: z.enum(['QUEUED', 'SUCCESS', 'FAILED', 'UNEXPECTED', 'UNKNOWN']),
            updatedAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export type StatusReceipt = z.infer<typeof receiptSchema>;
export const receiptSignature = (secret: string, value: StatusReceipt) =>
  createHmac('sha256', secret)
    .update('pos-whole-order-status-receipt-v1\0' + JSON.stringify(receiptSchema.parse(value)))
    .digest('base64url');
export function verifiedReceipt(
  secret: string,
  raw: unknown,
  signature: string | null,
  expected: {
    operationId: string;
    requestHash: string;
    scopeHash: string;
    platform: StatusPlatform;
  },
): StatusReceipt {
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature))
    throw unknownStatusOutcome();
  const value = parsed.data,
    a = Buffer.from(signature),
    b = Buffer.from(receiptSignature(secret, value));
  if (
    a.length !== b.length ||
    !timingSafeEqual(a, b) ||
    value.operationId !== expected.operationId ||
    value.requestHash !== expected.requestHash ||
    value.scopeHash !== expected.scopeHash ||
    new Set(value.stages.map((row) => row.platform)).size !== value.stages.length ||
    value.stages.some((row) => !requiredStages(expected.platform).includes(row.platform)) ||
    (value.state === 'succeeded' &&
      (!value.acceptedAt ||
        !value.completedAt ||
        requiredStages(expected.platform).some(
          (stage) =>
            !value.stages.some((row) => row.platform === stage && row.status === 'SUCCESS'),
        ))) ||
    (value.state === 'queued' && (!value.acceptedAt || !value.taskId || value.completedAt !== null))
  )
    throw unknownStatusOutcome();
  return value;
}
export const unknownStatusOutcome = () =>
  new AppError(
    502,
    'WHOLE_ORDER_STATUS_OUTCOME_UNKNOWN',
    'The status request outcome needs reconciliation. Refresh its receipt; it will not be sent again.',
  );
export const statusReconciliation = () =>
  new AppError(
    409,
    'WHOLE_ORDER_STATUS_RECONCILIATION_REQUIRED',
    'This whole-order status scope needs reconciliation before another request can be sent.',
  );
export const statusState = z.enum([
  'PENDING',
  'SENDING',
  'QUEUED',
  'SUCCEEDED',
  'REJECTED',
  'UNCERTAIN',
  'BLOCKED',
]);
export type StatusState = z.infer<typeof statusState>;
export interface SourceStatusLog {
  id: string;
  platform: string | null;
  status: string | null;
  updatedAt: string;
}
export function sourceStatusPresentation(logs: readonly SourceStatusLog[]) {
  const stages: {
    CREATE: { status: string | null; date: string };
    PACK: { status: string | null; date: string };
    SHIP: { status: string | null; date: string };
    DELIVER: { status: string | null; date: string };
  } = {
    CREATE: { status: '-', date: '' },
    PACK: { status: '-', date: '' },
    SHIP: { status: '-', date: '' },
    DELIVER: { status: '-', date: '' },
  };
  for (const row of [...logs].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  )) {
    if (
      row.platform === 'CREATE' ||
      row.platform === 'PACK' ||
      row.platform === 'SHIP' ||
      row.platform === 'DELIVER'
    )
      stages[row.platform] = { status: row.status, date: row.updatedAt };
  }
  if (stages.PACK.status === 'SUCCESS') stages.CREATE = { status: 'SUCCESS', date: '' };
  return stages;
}
