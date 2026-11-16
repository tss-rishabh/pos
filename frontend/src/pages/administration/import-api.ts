import { z } from 'zod';
import { requestWithResponse } from '../../api/client';
import { administrationIdentifier } from './api';

export const stockImportHeaders = [
  'SkuId',
  'StoreId',
  'IsHold',
  'Hold/UnholdQty',
  'IsAvailable',
  'IsDelete',
] as const;
export const importJobSchema = z.object({
  id: z.uuid(),
  actorId: administrationIdentifier,
  name: z.string(),
  state: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'BLOCKED']),
  totalRows: z.number().int().min(1).max(5000),
  processedRows: z.number().int().min(0).max(5000),
  successfulRows: z.number().int().min(0).max(5000),
  failedRows: z.number().int().min(0).max(5000),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImportJob = z.infer<typeof importJobSchema>;
const cells = z.tuple([
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
  z.string().max(128),
]);
const command = z.object({
  productId: administrationIdentifier,
  storeId: administrationIdentifier,
  movement: z.enum(['hold', 'unhold', 'none']),
  quantity: z.number().int().min(0),
  available: z.boolean().nullable(),
  archived: z.boolean().nullable(),
});
export const importPreviewSchema = z.object({
  totalRows: z.number().int().min(1).max(5000),
  validRows: z.number().int().min(0),
  invalidRows: z.number().int().min(0),
  remainingRows: z.number().int().min(0),
  requiresStockProcedure: z.boolean(),
  canSubmit: z.boolean(),
  rows: z
    .array(
      z.object({
        rowNumber: z.number().int().min(2).max(5001),
        cells,
        command: command.nullable(),
        errorCode: z.string().nullable(),
        message: z.string().nullable(),
        saleableStock: z.number().int().nullable(),
        heldStock: z.number().int().nullable(),
      }),
    )
    .max(100),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export const importRowSchema = z.object({
  importId: z.uuid(),
  rowNumber: z.number().int().min(2).max(5001),
  cells,
  command: command.nullable(),
  state: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
});
export const importCapabilitiesSchema = z.object({
  maximumBytes: z.number().int().min(1).max(262144),
  maximumRows: z.number().int().min(1).max(5000),
  visibilityEnabled: z.boolean(),
  stockEnabled: z.boolean(),
  historyEnabled: z.boolean(),
});

export async function downloadImportCsv(
  path: string,
  filename: string,
  operatorId: string,
): Promise<void> {
  if (
    !/^\/api\/v1\/admin\/inventory-imports\/(?:template|[0-9a-f-]{36}\/failures\.csv)$/i.test(path)
  )
    throw new Error('Choose an import download.');
  const blob = await requestWithResponse(
    path,
    {
      operatorId,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'text/csv' },
    },
    async (response) => {
      const value = await response.blob();
      if (
        value.size > 4 * 1024 * 1024 ||
        !response.headers.get('content-type')?.startsWith('text/csv')
      )
        throw new Error('The CSV download is unavailable.');
      return value;
    },
  );
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
