import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';

export const legacyActionSchema = z.enum(['packing', 'rto-receipt']);
export const legacyRequestSchema = z
  .object({
    commandId: z.uuid().transform((value) => value.toLowerCase()),
    note: z.string().max(255).default(''),
  })
  .strict();
export const sourceActionSchema = z.enum([
  'ACCEPTED',
  'DECLINED',
  'NO_ACTION',
  'CREATION_FAILED',
  'CONVERT_ONLINE',
]);
export type LegacyAction = z.infer<typeof legacyActionSchema>;
export interface LegacyLogState {
  action: string;
  createdInBorzo: number | null;
  packed: number | null;
  rto: number | null;
  received: number | null;
  borzoId: bigint;
}
export function sourceLegacyStatus(log: Pick<LegacyLogState, 'action' | 'createdInBorzo'> | null) {
  if (log?.action === 'ACCEPTED' && log.createdInBorzo === 1)
    return { status: '200' as const, message: 'Order Created Succesfully at Borzo', error: '' };
  if (log?.action === 'CREATION_FAILED')
    return {
      status: '400' as const,
      message: 'Failed',
      error: 'Courier creation failed. Review the delivery configuration.',
    };
  if (log?.action === 'DECLINED')
    return { status: '400' as const, message: 'Failed', error: 'Order already canceled' };
  if (log?.action === 'NO_ACTION')
    return { status: '400' as const, message: 'Failed', error: 'Order creation not attempted' };
  return { status: '400' as const, message: 'Failed', error: 'Order not created' };
}
export const legacyRtoCorrectionContract = 'pos-legacy-rto-same-store-hp-v1';
/** AjaxHlOrderView.cancel logs this before its webhook stock restoration. */
export const legacyCancellationAudit = 'Hyperlocal Order Cancelled : Amount Refunded';
export function legacyAuditComment(action: LegacyAction, note: string, firstName: string | null) {
  // Legacy order/views.py:4088,4149 format request.user.first_name (nullable) in an
  // f-string, so NULL prints as 'None'.
  const name = firstName ?? 'None',
    suffix =
      action === 'packing' ? `, Order Packed By: ${name}` : `, RTO Package Recieved By: ${name}`,
    comment = note + suffix;
  if ([...comment].length > 255)
    throw new AppError(
      422,
      'LEGACY_COMMENT_TOO_LONG',
      'The note and operator attribution exceed the legacy audit limit.',
    );
  return comment;
}
export function legacyTrackingUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
export interface RtoLine {
  hasProductId: string;
  productId: string;
  subProductId: string;
  quantity: string;
  platform: string;
}
export interface RtoStock {
  productId: string;
  stock: number;
}
export const rtoStepSchema = z
  .object({
    hasProductId: identifier,
    productId: identifier,
    quantity: z.string().regex(/^[1-9]\d{0,18}$/),
    before: z.number().int().min(-2147483648).max(2147483647),
    after: z.number().int().nonnegative().max(2147483647),
  })
  .strict();
export type RtoStep = z.infer<typeof rtoStepSchema>;
/** Preserve per-HP stock/audit steps. Only the wrong-split target and repeat behavior are corrected. */
export function legacyRtoPlan(
  split: boolean,
  lines: readonly RtoLine[],
  stocks: readonly RtoStock[],
) {
  const selected = lines.filter((line) => !split || line.platform === '4'),
    stock = new Map<string, number>(),
    seen = new Set<string>(),
    steps: RtoStep[] = [];
  let units = 0n;
  if (!selected.length || lines.length > 1000)
    throw new AppError(
      409,
      'LEGACY_RTO_LINES_UNCONFIRMED',
      'The returning line items require reconciliation.',
    );
  for (const row of stocks) {
    if (
      stock.has(row.productId) ||
      !Number.isInteger(row.stock) ||
      row.stock < -2147483648 ||
      row.stock > 2147483647
    )
      throw new AppError(
        409,
        'LEGACY_RTO_STOCK_UNCONFIRMED',
        'The store inventory requires reconciliation.',
      );
    stock.set(row.productId, row.stock);
  }
  for (const line of [...selected].sort((left, right) =>
    BigInt(left.hasProductId) < BigInt(right.hasProductId) ? -1 : 1,
  )) {
    if (
      seen.has(line.hasProductId) ||
      !/^\d{1,19}$/.test(line.quantity) ||
      BigInt(line.quantity) <= 0n
    )
      throw new AppError(
        409,
        'LEGACY_RTO_LINES_UNCONFIRMED',
        'The returning line items require reconciliation.',
      );
    seen.add(line.hasProductId);
    const before = stock.get(line.productId),
      quantity = BigInt(line.quantity);
    if (before === undefined)
      throw new AppError(
        409,
        'LEGACY_RTO_STOCK_ASSOCIATION_REQUIRED',
        'Create the verified store inventory association before receiving this return.',
      );
    const after = BigInt(before) + quantity;
    if (after < 0n || after > 2147483647n)
      throw new AppError(
        409,
        'LEGACY_RTO_STOCK_RANGE',
        'The returning quantity exceeds the supported store inventory range.',
      );
    steps.push(
      rtoStepSchema.parse({
        hasProductId: line.hasProductId,
        productId: line.productId,
        quantity: line.quantity,
        before,
        after: Number(after),
      }),
    );
    stock.set(line.productId, Number(after));
    units += quantity;
  }
  return { steps, totalUnits: units.toString(), excludedLineCount: lines.length - selected.length };
}
export const legacyReceiptSchema = z
  .object({
    commandId: z.uuid().transform((value) => value.toLowerCase()),
    actorId: identifier,
    storeId: identifier,
    orderId: identifier,
    action: legacyActionSchema,
    outcome: z.enum(['packed', 'rto-received', 'already-recorded']),
    originalCommandId: z.uuid().nullable(),
    recordedBy: z.enum(['rewrite', 'legacy']),
    auditId: identifier.nullable(),
    restoredUnits: z.string().regex(/^\d{1,25}$/),
    split: z.boolean(),
    excludedLineCount: z.number().int().nonnegative().max(1000),
    steps: z.array(rtoStepSchema).max(1000),
    syncEventId: z.uuid().nullable(),
    integrationState: z.enum(['not-required', 'pending', 'delivered', 'unconfirmed']),
    createdAt: z.number().int().safe().positive(),
    correctionContract: z.literal(legacyRtoCorrectionContract).nullable(),
  })
  .strict();
export type LegacyReceipt = z.infer<typeof legacyReceiptSchema>;
