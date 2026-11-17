import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { wholeOrderStatusContract, platform } from './domain.js';
import type { WholeOrderStatusOptions } from './options.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  proofSchema = z
    .object({
      contract: z.literal(wholeOrderStatusContract),
      operationId: z.uuid(),
      operatorId: identifier,
      authVersion: digest,
      storeId: identifier,
      counterId: identifier,
      scopeHash: digest,
      requestHash: digest,
      requestId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[\x21-\x7e]+$/)
        .nullable(),
    })
    .strict();
export type StatusReceiverProof = z.infer<typeof proofSchema>;
export const receiverBody = z
  .object({ orderId: identifier, has_product_ids: z.array(identifier).min(1).max(10000), platform })
  .strict();
export const statusServiceDenied = () =>
  new AppError(
    401,
    'WHOLE_ORDER_STATUS_SERVICE_UNAUTHORIZED',
    'The status service credentials are invalid.',
  );
function equalSecret(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Verify both independent service credentials before even reading the operation table. */
export function authenticateStatusReceiver(
  headers: Record<string, unknown>,
  options: WholeOrderStatusOptions,
): StatusReceiverProof {
  const key = headers['x-api-key'],
    scope = headers['x-pos-status-scope'],
    proof = headers['x-pos-status-proof'],
    operation = headers['idempotency-key'];
  if (
    !options.BACKEND_SYNC_REPO_API_KEY ||
    !options.WHOLE_ORDER_STATUS_RECEIPT_KEY ||
    typeof key !== 'string' ||
    typeof scope !== 'string' ||
    typeof proof !== 'string' ||
    typeof operation !== 'string' ||
    scope.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(scope) ||
    !/^[A-Za-z0-9_-]{43}$/.test(proof) ||
    !equalSecret(key, options.BACKEND_SYNC_REPO_API_KEY)
  )
    throw statusServiceDenied();
  const expected = createHmac('sha256', options.WHOLE_ORDER_STATUS_RECEIPT_KEY)
    .update('pos-whole-order-status-request-v1\0' + scope)
    .digest('base64url');
  if (!equalSecret(proof, expected)) throw statusServiceDenied();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(scope, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw statusServiceDenied();
  }
  const parsed = proofSchema.safeParse(raw);
  if (!parsed.success || parsed.data.operationId !== operation) throw statusServiceDenied();
  return parsed.data;
}
