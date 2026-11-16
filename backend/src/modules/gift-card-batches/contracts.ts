import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export const giftCardBatchId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const giftCardBatchPhases = [
  'QUEUED',
  'GENERATED',
  'STORED',
  'SENDING',
  'DELIVERED',
  'BLOCKED',
  'UNCERTAIN',
  'FAILED',
] as const;
export type GiftCardBatchPhase = (typeof giftCardBatchPhases)[number];
const version = z.string().regex(/^[a-f0-9]{64}$/);
export const createGiftCardBatchInput = z
  .object({
    operationId: z.uuid(),
    size: z.number().int().min(1).max(10000),
    message: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\p{C}]/u.test(value), 'Use printable batch message text.'),
  })
  .strict();
export const printGiftCardBatchInput = z
  .object({ operationId: z.uuid(), expectedVersion: version, printed: z.literal(true) })
  .strict();
export const blockGiftCardBatchInput = z
  .object({ operationId: z.uuid(), expectedVersion: version, blocked: z.boolean() })
  .strict();
export const retryGiftCardBatchInput = z
  .object({ operationId: z.uuid(), expectedVersion: version, confirmResend: z.boolean() })
  .strict();
const date = z.iso.date().refine((value) => {
  try {
    return Temporal.PlainDate.from(value).year >= 1000;
  } catch {
    return false;
  }
});
export const giftCardBatchSearchInput = z
  .object({
    viewOperationId: z.uuid().optional(),
    from: date.nullable().default(null),
    to: date.nullable().default(null),
    search: z.string().max(255).default(''),
    start: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).default(0),
    length: z.number().int().min(1).max(500).default(10),
    sort: z.enum(['id', 'size', 'message', 'createdBy', 'createdAt']).default('id'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .refine(
    (value) => (value.from === null) === (value.to === null),
    'Choose both dates or all history.',
  )
  .refine((value) => !value.from || !value.to || value.from <= value.to, 'Choose dates in order.');
export type GiftCardBatchSearchInput = z.infer<typeof giftCardBatchSearchInput>;
export interface GiftCardArchiveManifest {
  key: string;
  checksum: string;
  size: number;
}
export interface GiftCardBatchStorage {
  keyFor(id: string): string;
  put(manifest: GiftCardArchiveManifest, bytes: Buffer, signal?: AbortSignal): Promise<void>;
  get(manifest: GiftCardArchiveManifest, signal?: AbortSignal): Promise<Buffer>;
  close(): void;
}
export type GiftCardBatchDeliveryOutcome = 'accepted' | 'rejected' | 'uncertain';
export interface GiftCardBatchDelivery {
  send(
    attemptId: string,
    input: { batchId: string; recipient: string; archive: Buffer; requestId?: string },
    signal?: AbortSignal,
  ): Promise<GiftCardBatchDeliveryOutcome>;
}
export interface GiftCardBatchReceipt {
  id: string;
  batchId: string;
  status: 'success';
  message: string;
}
