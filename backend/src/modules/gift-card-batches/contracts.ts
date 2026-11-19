import { z } from 'zod';

/** gift_card_collection.id (BIGINT). */
export const giftCardBatchId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);

/**
 * `AjaxGenerateGiftCardView` (core/views.py:2186-2210). Legacy accepts `size` and `message` and
 * requires both to be truthy; the page validates 1..10 000 (gift_card/index.html:240-258).
 * `operationId` keys the Redis idempotency receipt (`pos:idem:gift_card_batch:{operationId}`).
 */
export const createGiftCardBatchInput = z
  .object({
    operationId: z.uuid(),
    size: z.number().int().min(1).max(10000),
    message: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !/[\p{C}]/u.test(value), 'Use printable batch message text.'),
  })
  .strict();
export type CreateGiftCardBatchInput = z.infer<typeof createGiftCardBatchInput>;

/** `AjaxBlockGiftCardView` (core/views.py:2240-2260): `opr` is `block` or `active`. */
export const blockGiftCardBatchInput = z.object({ opr: z.enum(['block', 'active']) }).strict();

/** `AjaxGiftCardListView` DataTables request (core/datatables/gift_card_datatable.py:24-60). */
export const giftCardBatchListInput = z
  .object({
    draw: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(1),
    search: z.string().max(255).default(''),
    start: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).default(0),
    length: z.number().int().min(1).max(500).default(10),
    sort: z.enum(['id', 'size', 'message', 'created_by', 'created_at']).default('id'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export type GiftCardBatchListInput = z.infer<typeof giftCardBatchListInput>;

/** Job arguments: ids and scalars only (no phone, email or password). */
export const generateGiftCardBatchArgs = z
  .object({
    collectionId: giftCardBatchId,
    size: z.number().int().min(1).max(10000),
    userId: z.string().regex(/^[1-9]\d{0,18}$/),
  })
  .strict();
export type GenerateGiftCardBatchArgs = z.infer<typeof generateGiftCardBatchArgs>;

export interface GiftCardBatchResult {
  batchId: string;
  status: 'success';
  message: string;
}

/** Legacy `helpers/storage.py:upload(key, data)`. */
export interface GiftCardBatchStorage {
  upload(key: string, bytes: Buffer, signal?: AbortSignal): Promise<void>;
  close(): void;
}
/** Legacy `Helpers.send_mail` (helpers/helpers.py:1462-1475). Returns whether Netcore accepted it. */
export interface GiftCardBatchDelivery {
  send(
    input: { collectionId: string; recipient: string; archive: Buffer },
    signal?: AbortSignal,
  ): Promise<boolean>;
}
