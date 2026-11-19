import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

/** Desktop offline billing upload (Phase D2 item 6). The device-side schema is
 * frontend/src/offline/billing/sync-contract.ts; both must stay identical. */
export const PROVISIONAL_REFERENCE =
  /^OFF-([1-9]\d{0,19})-([1-9]\d{0,19})-([A-Z0-9]{8})-([1-9]\d{0,8})$/;
const money = z.string().regex(/^\d{1,10}\.\d{2}$/);
/** Legacy order_stores/has_products salesperson columns are signed INT. */
const salespersonId = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .refine((value) => BigInt(value) <= 2147483647n, 'Invalid salesperson.');
const tenderReference = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{3,99}$/);

export const offlineSaleParamsSchema = z
  .object({ storeId: identifier, counterId: identifier })
  .strict();
export const offlineSaleUploadSchema = z
  .object({
    saleId: z.uuid(),
    provisionalRef: z.string().max(55).regex(PROVISIONAL_REFERENCE),
    deviceId: z.string().regex(/^[a-f0-9]{32}$/),
    billedBy: identifier,
    billedAt: z.number().int().positive(),
    lines: z
      .array(
        z
          .object({
            productId: identifier,
            quantity: z.number().int().min(1).max(999),
            unitPrice: money,
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
        'Each product may appear once.',
      ),
    salespersonId,
    payable: money,
    tender: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('cash'), received: money }).strict(),
      z.object({ mode: z.literal('card'), reference: tenderReference }).strict(),
      z.object({ mode: z.literal('upi'), reference: tenderReference }).strict(),
    ]),
    /** Manager decision for a conflict. For an unknown outcome the manager either links the
     * order found in Orders ('link-order' with its ID) or confirms that Orders has no order for
     * this sale ('recreate'); nothing is ever resubmitted without that decision. */
    resolution: z
      .object({
        action: z.enum(['accept', 'correct-tender', 'link-order', 'recreate']),
        managerId: identifier,
        reason: z.string().min(5).max(200),
        orderId: identifier.optional(),
      })
      .strict()
      .refine((value) => (value.action === 'link-order') === (value.orderId !== undefined), {
        message: 'An order ID is required only when linking an order.',
        path: ['orderId'],
      })
      .nullable(),
  })
  .strict();
export type OfflineSaleUpload = z.infer<typeof offlineSaleUploadSchema>;

export interface OfflineSaleResult {
  status: 'created' | 'existing';
  orderId: string;
  invoiceNumber: string | null;
  provisionalRef: string;
}

export type OfflineConflictCode =
  | 'STOCK_SHORTFALL'
  | 'PRICE_CHANGED'
  | 'TENDER_REFERENCE_NOT_FOUND'
  | 'OPERATOR_REVOKED'
  | 'OUTCOME_UNKNOWN'
  | 'REJECTED';

/** Minor units from a two-decimal string; never floating point. */
export function minor(value: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  if (!match) throw new RangeError('Invalid amount.');
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}
export function decimal(value: bigint): string {
  if (value < 0n) throw new RangeError('Invalid amount.');
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
