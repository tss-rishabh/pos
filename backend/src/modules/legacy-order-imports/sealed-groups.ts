import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { LegacyImportGroup } from './csv.js';
import { offlineOrderImportPlan, shopifyOrderImportPlan } from './plans.js';

const groupSchema: z.ZodType<LegacyImportGroup> = z
  .object({
    sequence: z.number().int().min(1).max(50000),
    firstRow: z.number().int().min(2).max(50001),
    reference: z.string().min(1).max(255),
    details: z.record(z.string().regex(/^[a-z_]+$/), z.string().max(131072)),
    address: z.record(z.string().regex(/^shipping_[a-z0-9]+$/), z.string().max(1000)).nullable(),
    lines: z
      .array(
        z
          .object({
            row: z.number().int().min(2).max(50001),
            productId: z.string().max(32),
            quantity: z.string().max(32),
            price: z.string().max(64),
          })
          .strict(),
      )
      .min(1)
      .max(999),
  })
  .strict();
export const importScopeSchema = z.object({ storeId: identifier, counterId: identifier }).strict();
export type ImportScope = z.infer<typeof importScopeSchema>;
const bindingSchema = z
  .object({
    jobId: z.uuid(),
    operationId: z.uuid(),
    actorId: identifier,
    storeId: identifier,
    counterId: identifier,
    sequence: z.number().int().min(1).max(50000),
    kind: z.enum(['offline', 'shopify']),
  })
  .strict();
export type ImportBinding = z.infer<typeof bindingSchema>;
function bindingText(binding: ImportBinding): string {
  const value = bindingSchema.parse(binding);
  return JSON.stringify([
    'pos-legacy-order-import-v1',
    value.jobId,
    value.operationId,
    value.actorId,
    value.storeId,
    value.counterId,
    value.sequence,
    value.kind,
  ]);
}
function secretKey(secret: string): Buffer {
  if (!/^[\x21-\x7e]{32,4096}$/.test(secret))
    throw new AppError(
      503,
      'ORDER_IMPORT_KEY_UNAVAILABLE',
      'Order import encryption is unavailable.',
    );
  return createHmac('sha256', secret).update('legacy-order-imports:encryption:v1').digest();
}
export function importDigest(secret: string, purpose: 'request' | 'group', value: string): string {
  secretKey(secret);
  return createHmac('sha256', secret)
    .update('legacy-order-imports:' + purpose + ':v1:')
    .update(value)
    .digest('hex');
}
export function validatedImportGroup(binding: ImportBinding, value: unknown) {
  bindingSchema.parse(binding);
  const group = groupSchema.parse(value),
    plan =
      binding.kind === 'offline' ? offlineOrderImportPlan(group) : shopifyOrderImportPlan(group);
  if (group.sequence !== binding.sequence || plan.storeId !== binding.storeId)
    throw new AppError(
      409,
      'ORDER_IMPORT_BINDING_INVALID',
      'The import order does not match its recorded scope.',
    );
  return { group, plan };
}
export function sealImportGroup(secret: string, binding: ImportBinding, value: unknown) {
  const { group } = validatedImportGroup(binding, value),
    plaintext = Buffer.from(JSON.stringify(group));
  if (plaintext.length > 256000)
    throw new AppError(
      422,
      'ORDER_IMPORT_ORDER_TOO_LARGE',
      'An individual import order exceeds its payload limit.',
    );
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', secretKey(secret), nonce);
  cipher.setAAD(Buffer.from(bindingText(binding)));
  const bytes = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
}
export function openImportGroup(secret: string, binding: ImportBinding, value: string) {
  try {
    if (value.length > 342000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length < 29 || bytes.length > 256028 || bytes.toString('base64url') !== value)
      throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', secretKey(secret), bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(bindingText(binding)));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const raw: unknown = JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
    );
    return validatedImportGroup(binding, raw);
  } catch {
    throw new AppError(
      409,
      'ORDER_IMPORT_PAYLOAD_INVALID',
      'The stored import order could not be verified.',
    );
  }
}
