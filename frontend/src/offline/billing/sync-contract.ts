import { z } from 'zod';
import {
  identifier,
  provisionalReferenceSchema,
  salespersonIdSchema,
  tenderReference,
} from './contracts';

/** Device → backend upload contract for POST
 * /api/v1/stores/:storeId/counters/:counterId/offline-sales. The backend
 * module backend/src/modules/offline-sync/contracts.ts validates the same shape. */
const money = z.string().regex(/^\d{1,10}\.\d{2}$/);
export const offlineSaleUploadSchema = z
  .object({
    saleId: z.uuid(),
    provisionalRef: provisionalReferenceSchema,
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
      .max(100),
    salespersonId: salespersonIdSchema,
    payable: money,
    tender: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('cash'), received: money }).strict(),
      z.object({ mode: z.literal('card'), reference: tenderReference }).strict(),
      z.object({ mode: z.literal('upi'), reference: tenderReference }).strict(),
    ]),
    resolution: z
      .object({
        action: z.enum(['accept', 'correct-tender', 'link-order', 'recreate']),
        managerId: identifier,
        reason: z.string().min(5).max(200),
        orderId: identifier.optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type OfflineSaleUpload = z.infer<typeof offlineSaleUploadSchema>;

export const offlineSaleResultSchema = z.object({
  status: z.enum(['created', 'existing']),
  orderId: identifier,
  invoiceNumber: z.string().max(100).nullable(),
  provisionalRef: provisionalReferenceSchema,
});
export type OfflineSaleResult = z.infer<typeof offlineSaleResultSchema>;

export const offlineSettingsSchema = z.object({
  maxMinutes: z.number().int().min(1),
  maxOrders: z.number().int().min(1),
});

/** Conflict codes are returned as `OFFLINE_CONFLICT_<CODE>` AppError codes. */
export const CONFLICT_PREFIX = 'OFFLINE_CONFLICT_';
export const serverErrorSchema = z.object({
  error: z.object({ code: z.string().max(100), message: z.string().max(500) }),
});
