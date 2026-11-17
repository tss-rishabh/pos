import { z } from 'zod';
import { post, request, requestWithResponse } from '../../../api/client';
const identifier = z.string().regex(/^[1-9]\d{0,19}$/);
export const importCounterSchema = z
  .object({ storeId: identifier, counterId: identifier })
  .strict();
const common = {
  id: z.uuid(),
  csv: z.string().min(1).max(5242880),
  counters: z.array(importCounterSchema).min(1).max(100),
};
export const importInputSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('offline') }).strict(),
  z.object({ ...common, kind: z.literal('shopify'), storeId: identifier }).strict(),
]);
export type OrderImportInput = z.infer<typeof importInputSchema>;
const count = z.number().int().min(0).max(50000),
  timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/),
  errorCode = z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable();
export const orderImportJobSchema = z
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
  .strict();
export const orderImportResultSchema = z
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
export const orderImportCapabilitiesSchema = z
  .object({
    ready: z.boolean(),
    canPreview: z.literal(true),
    kinds: z.tuple([z.literal('offline'), z.literal('shopify')]),
    maximumFileBytes: z.literal(5242880),
    maximumRows: z.literal(50000),
    maximumStores: z.literal(100),
  })
  .strict();
export const orderImportPreviewSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['offline', 'shopify']),
    totalOrders: count.min(1),
    totalUnits: z.number().int().positive().max(49950000),
    lineValue: z.string().regex(/^\d+\.\d{2}$/),
    scopes: z.array(importCounterSchema).min(1).max(100),
    earliestBusinessDate: z.iso.date(),
    latestBusinessDate: z.iso.date(),
  })
  .strict();
const resultsSchema = z
  .object({ data: z.array(orderImportResultSchema).max(100), nextAfter: count.min(1).nullable() })
  .strict();
export type OrderImportJob = z.infer<typeof orderImportJobSchema>;
export type OrderImportResult = z.infer<typeof orderImportResultSchema>;
export type OrderImportPreview = z.infer<typeof orderImportPreviewSchema>;
export type OrderImportCapabilities = z.infer<typeof orderImportCapabilitiesSchema>;
export const importIsTerminal = (job: OrderImportJob) =>
  ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(job.state);
const base = '/api/v1/admin/order-imports';
export const readImportCapabilities = (operatorId: string) =>
  request(base + '/capabilities', { operatorId }, orderImportCapabilitiesSchema);
export const previewOrderImport = (operatorId: string, body: OrderImportInput) =>
  post(base + '/previews', body, orderImportPreviewSchema, operatorId);
export const stageOrderImport = (operatorId: string, body: OrderImportInput) =>
  post(base, body, orderImportJobSchema, operatorId);
export const readOrderImport = (operatorId: string, jobId: string) =>
  request(base + '/' + z.uuid().parse(jobId), { operatorId }, orderImportJobSchema);
export const readImportResults = (operatorId: string, jobId: string, after = 0) =>
  request(
    base + '/' + z.uuid().parse(jobId) + '/results?after=' + after + '&limit=50',
    { operatorId },
    resultsSchema,
  );
export const cancelOrderImport = (operatorId: string, jobId: string) =>
  post(base + '/' + z.uuid().parse(jobId) + '/cancellations', {}, orderImportJobSchema, operatorId);
export const downloadImportTemplate = (operatorId: string, kind: 'offline' | 'shopify') =>
  requestWithResponse(base + '/templates/' + kind, { operatorId }, (response) => response.blob());
