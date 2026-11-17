import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { operationHash } from '../checkout/crypto.js';

export const screeningOriginsContract = 'pos-screening-origins-v1' as const;
export const originHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const point = z.number().int().safe().positive();
export const screeningOriginSchema = z.enum([
  'customer',
  'legacy-django',
  'mpos',
  'external-system',
]);
export const originCommandSchema = z
  .object({
    contract: z.literal('pos-screening-origin-command-v1'),
    id: z.uuid(),
    origin: screeningOriginSchema,
    customerId: identifier,
    actorId: identifier.nullable(),
    storeId: identifier.nullable(),
    counterId: identifier.nullable(),
    namespaceHash: originHashSchema,
    requestHash: originHashSchema,
    cartHash: originHashSchema,
    referenceHash: originHashSchema,
    authorityHash: originHashSchema,
    quantity: z.number().int().min(1).max(2),
    markerRows: z.number().int().min(1).max(2),
    lineItemsEnabled: z.boolean(),
    phase: z.enum(['PREPARED', 'RESERVED', 'BOUND', 'COUNTED', 'REJECTED']),
    orderId: identifier.nullable(),
    lines: z.array(z.object({ id: identifier, quantity: z.number().int().min(1).max(2) }).strict()).max(2),
    markers: z.array(z.object({ id: identifier, lineId: identifier }).strict()).max(2),
    creationHash: originHashSchema.nullable(),
    closureHash: originHashSchema.nullable(),
    version: point,
    createdAt: point,
    updatedAt: point,
    expiresAt: point,
  })
  .strict()
  .superRefine((value, context) => {
    const staff = value.origin === 'legacy-django' || value.origin === 'mpos';
    const bound = value.phase === 'BOUND' || value.phase === 'COUNTED';
    if (
      [value.actorId, value.storeId, value.counterId].some((id) => staff !== (id !== null)) ||
      value.markerRows !== (value.lineItemsEnabled ? value.quantity : 1) ||
      bound !== (value.orderId !== null) ||
      bound !== (value.creationHash !== null) ||
      (value.phase === 'REJECTED') !== (value.closureHash !== null) ||
      value.lines.length !== (bound ? value.markerRows : 0) ||
      value.markers.length !== (bound ? value.markerRows : 0) ||
      new Set(value.lines.map((row) => row.id)).size !== value.lines.length ||
      new Set(value.markers.map((row) => row.id)).size !== value.markers.length ||
      new Set(value.markers.map((row) => row.lineId)).size !== value.markers.length ||
      value.markers.some((row) => !value.lines.some((line) => line.id === row.lineId)) ||
      (bound && value.lines.reduce((sum, line) => sum + line.quantity, 0) !== value.quantity) ||
      value.updatedAt < value.createdAt ||
      value.expiresAt <= value.createdAt ||
      value.expiresAt > value.createdAt + 600000
    ) context.addIssue({ code: 'custom', message: 'Invalid original command proof.' });
  });
export type ScreeningOriginCommand = z.infer<typeof originCommandSchema>;
export function originError(code = 'SCREENING_ORIGIN_RECONCILIATION_REQUIRED') {
  return new AppError(503, code, 'The original screening command requires verification.');
}
export function originDigest(secret: string, purpose: string, value: unknown): string {
  if (!/^[!-~]{32,4096}$/.test(secret) || !/^[a-z][a-z0-9-]{0,63}$/.test(purpose))
    throw originError('SCREENING_ORIGIN_KEY_REQUIRED');
  return operationHash('screening-origin.' + purpose + '.v1', value, secret);
}
export function sameOriginHash(left: string, right: string): boolean {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
