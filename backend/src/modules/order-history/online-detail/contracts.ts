import { z } from 'zod';
import { positiveId, nonnegativeId, sourceDate } from '../contracts.js';
import { onlineDetailContext } from './context.js';
export { positiveId as detailIdentifier } from '../contracts.js';

export const onlineOrderDetailContract = 'pos-source-online-order-detail-v1';
export const detailType = z.enum(['N', 'HL', 'HE']);
const boundedText = z.string().max(4096);
const decimal = z
  .string()
  .max(100)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const nullableReference = z
  .object({ id: nonnegativeId.nullable(), label: z.string().max(255).nullable() })
  .strict();
/**
 * `type` selects the source family. `from`/`to` are accepted from older links and ignored:
 * legacy `ShowOnlineOrderDetailsView` reads the order by id with no date window.
 */
export const onlineDetailSelection = z
  .object({
    type: detailType,
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.from) === Boolean(value.to), 'Supply both date boundaries.');
export type OnlineDetailSelection = z.infer<typeof onlineDetailSelection>;
const trackingUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !/[\u0000-\u0020\u007f\\]/.test(value)
      );
    } catch {
      return false;
    }
  });
export const onlineDetailLine = z
  .object({
    id: positiveId,
    productId: nonnegativeId,
    quantity: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
    amount: decimal,
    gst: decimal,
    status: z.string().max(255),
    platform: z.object({ id: nonnegativeId, name: z.string().max(255).nullable() }).strict(),
    express: z
      .array(
        z
          .object({
            id: positiveId,
            storeId: positiveId.nullable(),
            status: z.string().max(64).nullable(),
            pendingExpiresAt: sourceDate.nullable(),
            acceptedExpiresAt: sourceDate.nullable(),
            rejectionReasonId: nonnegativeId.nullable(),
            cancellationReason: z.string().max(255).nullable(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const onlineDetailTimeline = z
  .object({
    id: z.union([z.literal('placement'), positiveId]),
    createdAt: sourceDate,
    comment: boundedText,
    paymentStatus: z.string().max(255),
    orderStatus: z.string().max(255).nullable(),
    payments: z
      .array(
        z.object({ method: z.string().max(128), value: z.string().max(1024).nullable() }).strict(),
      )
      .max(100),
  })
  .strict();
/** Complete historical order facts; current profile/wallet are deliberately separate. */
export const onlineDetailFact = z
  .object({
    contract: z.literal(onlineOrderDetailContract),
    orderId: positiveId,
    customerId: positiveId,
    createdAt: sourceDate,
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }),
    reference: z.string().max(255),
    amount: decimal,
    payAmount: decimal,
    status: nullableReference,
    paymentStatus: nullableReference,
    paymentMethod: nullableReference,
    global: z.boolean(),
    split: z.boolean(),
    storeIds: z.array(positiveId).max(10000),
    delivery: z
      .object({
        locationId: nonnegativeId.nullable(),
        locationType: z.string().max(255),
        ownerStoreId: positiveId.nullable(),
        transfer: z.boolean(),
        nextStoreIds: z.array(positiveId).max(1000),
        startSlot: sourceDate.nullable(),
        endSlot: sourceDate.nullable(),
        parentOrderId: positiveId.nullable(),
        childOrderId: positiveId.nullable(),
        courier: z
          .object({
            id: nonnegativeId.nullable(),
            sourceTracking: trackingUrl.nullable(),
            destinationTracking: trackingUrl.nullable(),
          })
          .strict(),
        ticket: z
          .object({
            id: z.string().max(255).nullable(),
            status: z.string().max(255).nullable(),
            message: z.string().max(255).nullable(),
          })
          .strict(),
      })
      .strict(),
    lines: z.array(onlineDetailLine).max(10000),
    timeline: z.array(onlineDetailTimeline).max(10000),
  })
  .strict()
  .superRefine((value, context) => {
    const express = value.lines.flatMap((line) => line.express);
    if (express.length > 10000 || new Set(express.map((item) => item.id)).size !== express.length)
      context.addIssue({
        code: 'custom',
        message: 'The complete Express snapshot has invalid identities.',
      });
    if (
      new Set(value.lines.map((line) => line.id)).size !== value.lines.length ||
      new Set(value.timeline.map((event) => event.id)).size !== value.timeline.length ||
      new Set(value.storeIds).size !== value.storeIds.length
    )
      context.addIssue({
        code: 'custom',
        message: 'The complete order snapshot contains duplicate identities.',
      });
  });
export type OnlineDetailFact = z.infer<typeof onlineDetailFact>;
export const currentOrderCustomer = z
  .object({
    freshness: z.literal('current'),
    fetchedAt: z.iso.datetime({ offset: true }),
    id: positiveId,
    firstName: z.string().max(32),
    lastName: z.string().max(32),
    email: z.string().max(96),
    telephone: z.string().max(32),
    money: decimal,
    points: decimal,
    membership: z
      .object({
        active: z.boolean(),
        expiry: z.string().max(40).nullable(),
        message: z.string().max(255),
      })
      .strict(),
  })
  .strict();
export type CurrentOrderCustomer = z.infer<typeof currentOrderCustomer>;
export const currentOrderProducts = z
  .object({
    freshness: z.literal('current'),
    fetchedAt: z.iso.datetime({ offset: true }),
    items: z
      .array(
        z
          .object({
            id: positiveId,
            parentId: nonnegativeId,
            name: z.string().max(512).nullable(),
            typeId: nonnegativeId,
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export const onlineOrderDetail = z
  .object({
    type: detailType,
    storeId: positiveId,
    reader: z.literal('primary'),
    fetchedAt: z.iso.datetime({ offset: true }),
    fact: onlineDetailFact,
    customer: currentOrderCustomer,
    products: currentOrderProducts,
    context: onlineDetailContext,
  })
  .strict()
  .refine((value) => value.fact.customerId === value.customer.id, 'The order customer changed.')
  .refine((value) => {
    const ids = new Set(value.fact.lines.map((line) => line.productId));
    return (
      value.products.items.length === ids.size &&
      new Set(value.products.items.map((product) => product.id)).size === ids.size &&
      value.products.items.every((product) => ids.has(product.id))
    );
  }, 'The current product dimensions do not match this order.');
export type OnlineOrderDetail = z.infer<typeof onlineOrderDetail>;
