import { z } from 'zod';
import { PROVISIONAL_REFERENCE_PATTERN } from './reference';

/** IPC contracts shared by the Electron main process (which validates every
 * message) and the renderer (which validates every reply). */
export const identifier = z.string().regex(/^[1-9]\d{0,19}$/);
export const paise = z.number().int().min(0).max(9_999_999_999);
export const tenderReference = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]{3,99}$/,
    'Enter the card or UPI reference from the terminal.',
  );
export const provisionalReferenceSchema = z.string().max(55).regex(PROVISIONAL_REFERENCE_PATTERN);

export const tenderSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('cash'), receivedPaise: paise }).strict(),
  z.object({ mode: z.literal('card'), reference: tenderReference }).strict(),
  z.object({ mode: z.literal('upi'), reference: tenderReference }).strict(),
]);
export type Tender = z.infer<typeof tenderSchema>;

export const saleStatusSchema = z.enum(['queued', 'syncing', 'synced', 'needs_manager', 'voided']);
export type SaleStatus = z.infer<typeof saleStatusSchema>;
export const conflictCodeSchema = z.enum([
  'STOCK_SHORTFALL',
  'PRICE_CHANGED',
  'TENDER_REFERENCE_NOT_FOUND',
  'OPERATOR_REVOKED',
  'REJECTED',
]);
export type ConflictCode = z.infer<typeof conflictCodeSchema>;

export const ipcChannels = [
  'offline:status',
  'offline:catalog:search',
  'offline:catalog:barcode',
  'offline:catalog:refresh',
  'offline:sale:create',
  'offline:sale:list',
  'offline:sale:reprint',
  'offline:sync:status',
  'offline:sync:retry',
  'offline:conflict:resolve',
] as const;
export type IpcChannel = (typeof ipcChannels)[number];

const empty = z.object({}).strict();
export const ipcRequestSchemas = {
  'offline:status': empty,
  'offline:catalog:search': z
    .object({
      storeId: identifier,
      query: z.string().trim().max(100),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  'offline:catalog:barcode': z
    .object({
      storeId: identifier,
      barcode: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{1,64}$/),
    })
    .strict(),
  'offline:catalog:refresh': empty,
  'offline:sale:create': z
    .object({
      saleId: z.uuid(),
      storeId: identifier,
      counterId: identifier,
      lines: z
        .array(
          z.object({ productId: identifier, quantity: z.number().int().min(1).max(999) }).strict(),
        )
        .min(1)
        .max(100)
        .refine(
          (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
          'Each product may appear once.',
        ),
      tender: tenderSchema,
    })
    .strict(),
  'offline:sale:list': z
    .object({
      status: saleStatusSchema.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  'offline:sale:reprint': z.object({ saleId: z.uuid() }).strict(),
  'offline:sync:status': empty,
  'offline:sync:retry': empty,
  'offline:conflict:resolve': z
    .object({
      saleId: z.uuid(),
      action: z.enum(['accept', 'correct-tender', 'void']),
      reason: z.string().trim().min(5).max(200),
      tender: tenderSchema.optional(),
    })
    .strict()
    .refine((value) => (value.action === 'correct-tender') === Boolean(value.tender), {
      message: 'A corrected tender is required only when correcting the tender.',
      path: ['tender'],
    }),
} satisfies Record<IpcChannel, z.ZodType>;
export type IpcRequest<C extends IpcChannel> = z.input<(typeof ipcRequestSchemas)[C]>;
export type IpcParsedRequest<C extends IpcChannel> = z.output<(typeof ipcRequestSchemas)[C]>;

export const ipcEnvelopeSchema = z.object({ requestId: z.uuid(), payload: z.unknown() }).strict();

export const limitStatusSchema = z.object({
  allowed: z.boolean(),
  reason: z.enum(['NEVER_CONNECTED', 'CLOCK_INCONSISTENT', 'TIME_LIMIT', 'ORDER_LIMIT']).nullable(),
  minutesUsed: z.number().int().min(0),
  ordersUsed: z.number().int().min(0),
  maxMinutes: z.number().int().min(1),
  maxOrders: z.number().int().min(1),
  message: z.string(),
});
export const operatorSummarySchema = z.object({
  id: identifier,
  name: z.string().max(300),
  manager: z.boolean(),
  storeId: identifier.nullable(),
  counterId: identifier.nullable(),
  eligible: z.boolean(),
  message: z.string(),
});
export const statusSchema = z.object({
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  online: z.boolean(),
  lastContactAt: z.number().int().nullable(),
  operator: operatorSummarySchema.nullable(),
  limits: limitStatusSchema,
  catalog: z.object({
    storeId: identifier.nullable(),
    products: z.number().int().min(0),
    refreshedAt: z.number().int().nullable(),
  }),
  queue: z.object({
    queued: z.number().int().min(0),
    syncing: z.number().int().min(0),
    needsManager: z.number().int().min(0),
    synced: z.number().int().min(0),
    voided: z.number().int().min(0),
  }),
  syncing: z.boolean(),
  lastSyncAt: z.number().int().nullable(),
  lastSyncError: z.string().nullable(),
});
export type OfflineStatus = z.infer<typeof statusSchema>;

export const catalogProductSchema = z.object({
  productId: identifier,
  name: z.string(),
  barcode: z.string().nullable(),
  unitPricePaise: paise,
  stock: z.number().int(),
});
export type CatalogProduct = z.infer<typeof catalogProductSchema>;

export const saleLineSchema = z.object({
  productId: identifier,
  name: z.string(),
  unitPricePaise: paise,
  quantity: z.number().int().min(1),
});
export const conflictSchema = z.object({
  code: conflictCodeSchema,
  message: z.string(),
  createdAt: z.number().int(),
});
export const saleSchema = z.object({
  saleId: z.uuid(),
  provisionalRef: provisionalReferenceSchema,
  storeId: identifier,
  counterId: identifier,
  operatorId: identifier,
  operatorName: z.string(),
  createdAt: z.number().int(),
  status: saleStatusSchema,
  lines: z.array(saleLineSchema),
  grossPaise: paise,
  roundingPaise: paise,
  payablePaise: paise,
  tender: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('cash'), receivedPaise: paise, changePaise: paise }),
    z.object({ mode: z.literal('card'), reference: z.string() }),
    z.object({ mode: z.literal('upi'), reference: z.string() }),
  ]),
  orderId: identifier.nullable(),
  invoiceNumber: z.string().nullable(),
  syncedAt: z.number().int().nullable(),
  attempts: z.number().int().min(0),
  conflict: conflictSchema.nullable(),
  resolution: z
    .object({
      action: z.enum(['accept', 'correct-tender', 'void']),
      managerId: identifier,
      reason: z.string(),
      resolvedAt: z.number().int(),
    })
    .nullable(),
});
export type OfflineSale = z.infer<typeof saleSchema>;
export const receiptSchema = saleSchema.extend({
  provisionalNotice: z.string(),
  heading: z.string(),
});
export type OfflineReceipt = z.infer<typeof receiptSchema>;

export const ipcResponseSchemas = {
  'offline:status': statusSchema,
  'offline:catalog:search': z.object({ products: z.array(catalogProductSchema) }),
  'offline:catalog:barcode': z.object({ product: catalogProductSchema.nullable() }),
  'offline:catalog:refresh': z.object({ products: z.number().int().min(0) }),
  'offline:sale:create': z.object({ sale: saleSchema, receipt: receiptSchema }),
  'offline:sale:list': z.object({ sales: z.array(saleSchema) }),
  'offline:sale:reprint': z.object({ receipt: receiptSchema }),
  'offline:sync:status': statusSchema,
  'offline:sync:retry': statusSchema,
  'offline:conflict:resolve': z.object({ sale: saleSchema }),
} satisfies Record<IpcChannel, z.ZodType>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof ipcResponseSchemas)[C]>;

export const ipcErrorSchema = z.object({
  code: z.string().regex(/^[A-Z_]{2,64}$/),
  message: z.string().max(500),
});
export const ipcReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), requestId: z.uuid(), data: z.unknown() }),
  z.object({ ok: z.literal(false), requestId: z.uuid(), error: ipcErrorSchema }),
]);
export type IpcReply = z.infer<typeof ipcReplySchema>;

export const PROVISIONAL_NOTICE = 'Provisional — final invoice issued on sync';
