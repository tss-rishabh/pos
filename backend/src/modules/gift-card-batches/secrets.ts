import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { seal, unseal } from '../../auth/crypto.js';
import { AppError } from '../../domain/errors.js';
import type { GiftCardBatchOptions } from './options.js';

const secretSchema = z
  .object({
    purpose: z.literal('gift-card-batch-artifact-v1'),
    batchId: z.string().regex(/^[1-9]\d{0,18}$/),
    password: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    recipient: z.email(),
    formatFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type GiftCardBatchSecrets = z.infer<typeof secretSchema>;
const unavailable = () =>
  new AppError(503, 'GIFT_CARD_BATCH_KEYS_UNAVAILABLE', 'Gift card archive keys are unavailable.');
export function giftCardFormatFingerprint(salt: string) {
  return createHash('sha256').update('pos-gift-card-format-v1:').update(salt).digest('hex');
}
function encryptionKey(options: GiftCardBatchOptions, keyId: string, batchId: string) {
  const keys = options.GIFT_CARD_BATCH_ENCRYPTION_KEYS;
  if (!keys || !Object.hasOwn(keys, keyId)) throw unavailable();
  return `gift-card-batches:${keyId}:${batchId}:${keys[keyId]}`;
}
export function sealGiftCardSecrets(
  options: GiftCardBatchOptions,
  input: GiftCardBatchSecrets,
): string {
  const value = secretSchema.parse(input),
    id = options.GIFT_CARD_BATCH_ACTIVE_KEY_ID;
  if (!id) throw unavailable();
  return id + '.' + seal(value, encryptionKey(options, id, value.batchId));
}
export function openGiftCardSecrets(
  options: GiftCardBatchOptions,
  batchId: string,
  value: string,
): GiftCardBatchSecrets {
  const index = value.indexOf('.'),
    id = value.slice(0, index),
    ciphertext = value.slice(index + 1);
  if (index < 1 || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw unavailable();
  try {
    const parsed = secretSchema.parse(unseal(ciphertext, encryptionKey(options, id, batchId)));
    if (parsed.batchId !== batchId) throw unavailable();
    return parsed;
  } catch {
    throw unavailable();
  }
}
export function newGiftCardSecrets(
  options: GiftCardBatchOptions,
  batchId: string,
  recipient: string,
) {
  if (!options.GC_SALTKEY) throw unavailable();
  return sealGiftCardSecrets(options, {
    purpose: 'gift-card-batch-artifact-v1',
    batchId,
    recipient,
    password: randomBytes(32).toString('base64url'),
    formatFingerprint: giftCardFormatFingerprint(options.GC_SALTKEY),
  });
}
