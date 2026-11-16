import { z } from 'zod';

/** Source input masks insert underscores; Python int also removes leading zeroes. */
export const barcodeInteger = z
  .string()
  .max(64)
  .transform((value) => value.replaceAll('_', '').trim())
  .pipe(z.string().regex(/^\+?\d+$/))
  .transform((value) => BigInt(value).toString())
  .pipe(
    z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .refine(
        (value) => BigInt(value) <= 9223372036854775807n,
        'Value exceeds the signed legacy BIGINT range.',
      ),
  );
export const barcodeAssignmentInput = z
  .object({ operationId: z.uuid(), productId: barcodeInteger, barcode: barcodeInteger })
  .strict();
export type BarcodeAssignmentInput = z.infer<typeof barcodeAssignmentInput>;
const exactId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const barcodeReceipt = z
  .object({
    id: z.uuid(),
    operatorId: exactId,
    productId: exactId,
    barcode: exactId,
    status: z.enum(['success', 'fail']),
    code: z.enum(['ASSIGNED', 'INVALID_PRODUCT', 'PRODUCT_HAS_BARCODE', 'GTIN_ASSIGNED']),
    message: z.string().max(255),
    barcodeRowId: exactId.nullable(),
    auditId: exactId.nullable(),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,128}$/)
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const succeeded = value.status === 'success';
    if (
      succeeded !== (value.code === 'ASSIGNED') ||
      succeeded !== (value.barcodeRowId !== null) ||
      succeeded !== (value.auditId !== null)
    )
      context.addIssue({ code: 'custom', message: 'Barcode receipt evidence is inconsistent.' });
  });
export type BarcodeReceipt = z.infer<typeof barcodeReceipt>;
