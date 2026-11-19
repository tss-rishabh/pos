import { z } from 'zod';
import { captureOperatorScope, request } from '../../../api/client';
const integer = z
  .string()
  .max(64)
  .transform((value) => value.replaceAll('_', '').trim())
  .pipe(z.string().regex(/^\+?\d+$/))
  .transform((value) => BigInt(value).toString())
  .pipe(
    z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
  );
export const assignmentInput = z
  .object({ operationId: z.uuid(), productId: integer, barcode: integer })
  .strict();
export type AssignmentInput = z.infer<typeof assignmentInput>;
const exact = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const assignmentReceipt = z
  .object({
    id: z.uuid(),
    operatorId: exact,
    productId: exact,
    barcode: exact,
    status: z.enum(['success', 'fail']),
    code: z.enum(['ASSIGNED', 'INVALID_PRODUCT', 'PRODUCT_HAS_BARCODE', 'GTIN_ASSIGNED']),
    message: z.string().max(255),
    barcodeRowId: exact.nullable(),
    auditId: exact.nullable(),
    createdAt: z.string(),
    requestId: z.string().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.status === 'success') === (value.code === 'ASSIGNED') &&
      (value.status === 'success') === (value.barcodeRowId !== null) &&
      (value.status === 'success' || value.auditId === null),
  );
export type AssignmentReceipt = z.infer<typeof assignmentReceipt>;
export function matchesAssignment(
  receipt: AssignmentReceipt,
  ownerId: string,
  input: AssignmentInput,
) {
  if (
    receipt.id !== input.operationId ||
    receipt.operatorId !== ownerId ||
    receipt.productId !== input.productId ||
    receipt.barcode !== input.barcode
  )
    throw new Error(
      'The saved receipt belongs to a different assignment. Keep the original action for reconciliation.',
    );
  return receipt;
}
export async function assignBarcode(ownerId: string, input: AssignmentInput, signal: AbortSignal) {
  const scope = AbortSignal.any([captureOperatorScope(ownerId), signal]);
  return matchesAssignment(
    await request(
      '/api/v1/admin/barcode-assignments',
      { method: 'POST', operatorId: ownerId, body: JSON.stringify(input), signal: scope },
      assignmentReceipt,
    ),
    ownerId,
    input,
  );
}
export async function readAssignment(ownerId: string, input: AssignmentInput, signal: AbortSignal) {
  const scope = AbortSignal.any([captureOperatorScope(ownerId), signal]);
  return matchesAssignment(
    await request(
      '/api/v1/admin/barcode-assignments/' + input.operationId,
      { operatorId: ownerId, signal: scope },
      assignmentReceipt,
    ),
    ownerId,
    input,
  );
}
