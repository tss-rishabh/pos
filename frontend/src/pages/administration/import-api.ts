import { z } from 'zod';
import { requestWithResponse } from '../../api/client';
import { administrationIdentifier } from './api';

/** The legacy `pos_csv_upload.upload_type` with a live upload screen (the product-store page is deleted). */
export type UploadType = 'PRODUCT_STOCK_CSV';
export const uploadSummarySchema = z.object({
  id: administrationIdentifier,
  uploadType: z.enum(['PRODUCT_STOCK_CSV', 'PRODUCT_STORE_CSV']),
  uploadedBy: administrationIdentifier.nullable(),
  uploaderName: z.string().nullable().optional(),
  message: z.string().nullable(),
  isImported: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type UploadSummary = z.infer<typeof uploadSummarySchema>;
export const uploadPageSchema = z.object({
  data: z.array(uploadSummarySchema),
  nextBefore: administrationIdentifier.nullable(),
});
/** One `pos_csv_upload.failed_data` entry, as written by the source task. */
export const failedRecordSchema = z.object({
  data: z.record(z.string(), z.string().nullable()),
  message: z.string(),
  other_error: z.string().optional(),
});
export const uploadDetailSchema = uploadSummarySchema.extend({
  failedData: z.array(failedRecordSchema).nullable(),
});
export type UploadDetail = z.infer<typeof uploadDetailSchema>;
export const uploadResultSchema = z.object({ id: administrationIdentifier, message: z.string() });

/** Same-origin authenticated download of the source template. */
export async function downloadTemplate(type: UploadType, operatorId: string): Promise<void> {
  const { blob, filename } = await requestWithResponse(
    `/api/v1/admin/inventory-imports/template?type=${type}`,
    {
      operatorId,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'text/csv' },
    },
    async (response) => {
      const value = await response.blob();
      if (value.size > 64 * 1024 || !response.headers.get('content-type')?.startsWith('text/csv'))
        throw new Error('The CSV template is unavailable.');
      const name = /filename="([A-Za-z0-9_.-]+\.csv)"/.exec(
        response.headers.get('content-disposition') || '',
      )?.[1];
      return {
        blob: value,
        filename: name || (type === 'PRODUCT_STOCK_CSV' ? 'ProductStock.csv' : 'ProductStore.csv'),
      };
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
