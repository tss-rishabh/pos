import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

const count = z.number().int().min(0).max(50000);
export const importJobId = z.object({ jobId: z.uuid() }).strict();
export const importResultsInput = z
  .object({
    after: z.coerce.number().int().min(0).max(50000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const importKindInput = z.object({ kind: z.enum(['offline', 'shopify']) }).strict();
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/);
const errorCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .nullable();
export const importJobSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['offline', 'shopify']),
    state: z.enum([
      'STAGING',
      'QUEUED',
      'RUNNING',
      'COMPLETED',
      'PARTIAL',
      'FAILED',
      'CANCELLED',
      'BLOCKED',
    ]),
    totalOrders: count.min(1),
    importedOrders: count,
    failedOrders: count,
    cancelledOrders: count,
    errorCode,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp.nullable(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.importedOrders + job.failedOrders + job.cancelledOrders > job.totalOrders)
      context.addIssue({ code: 'custom', message: 'The import counters are inconsistent.' });
  });
export const importResultSchema = z
  .object({
    sequence: count.min(1),
    firstRow: z.number().int().min(2).max(50001),
    operationId: z.uuid(),
    storeId: identifier,
    counterId: identifier,
    state: z.enum(['PENDING', 'STARTING', 'RECONCILING', 'IMPORTED', 'FAILED', 'CANCELLED']),
    orderId: identifier.nullable(),
    receiptId: z.uuid().nullable(),
    businessDate: z.iso.date().nullable(),
    errorCode,
    updatedAt: timestamp,
  })
  .strict();
export const importCapabilitiesSchema = z
  .object({
    ready: z.boolean(),
    canPreview: z.literal(true),
    kinds: z.tuple([z.literal('offline'), z.literal('shopify')]),
    maximumFileBytes: z.literal(5242880),
    maximumRows: z.literal(50000),
    maximumStores: z.literal(100),
  })
  .strict();
export const importPreviewSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['offline', 'shopify']),
    totalOrders: count.min(1),
    totalUnits: z.number().int().positive().max(49950000),
    lineValue: z.string().regex(/^\d+\.\d{2}$/),
    scopes: z
      .array(z.object({ storeId: identifier, counterId: identifier }).strict())
      .min(1)
      .max(100),
    earliestBusinessDate: z.iso.date(),
    latestBusinessDate: z.iso.date(),
  })
  .strict();
export type ImportJobDto = z.infer<typeof importJobSchema>;
export type ImportResultDto = z.infer<typeof importResultSchema>;
export const importResumptionInput = z.object({ operationId: z.uuid() }).strict();
export const importResumptionSchema = z
  .object({ operationId: z.uuid(), jobId: z.uuid(), acceptedAt: timestamp })
  .strict();
export const importApprovalReviewSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.enum(['offline', 'shopify']),
    storeId: identifier,
    counterId: identifier,
    businessDate: z.iso.date(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    lineValue: z.string().regex(/^\d+\.\d{2}$/),
    correction: z
      .object({
        id: z.uuid(),
        historicalTenderAmount: z.string().regex(/^\d+\.\d{2}$/),
        sourcePayable: z.string().regex(/^\d+\.\d{2}$/),
      })
      .strict()
      .optional(),
    lines: z
      .array(
        z
          .object({
            productId: identifier,
            quantity: z.number().int().min(1).max(999),
            unitPrice: z.string().regex(/^\d+\.\d{2}$/),
          })
          .strict(),
      )
      .min(1)
      .max(999),
  })
  .strict();
