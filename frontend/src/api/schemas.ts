import { z } from 'zod';

const id = z.string().regex(/^\d{1,20}$/);
const money = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Number(value)), 'Invalid amount.');
export const principalSchema = z.object({
  userType: z.union([z.literal(1), z.literal(2)]),
  id,
  name: z.string().max(300),
  email: z.string().max(254),
  role: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  storeIds: z.array(id),
});
export const sessionSchema = z.object({
  user: principalSchema,
  sessionExpiresAt: z.number().int().positive(),
});
/** Public sign-in state probe: signed out is `session: null` with HTTP 200. */
export const sessionStateSchema = z.object({
  session: sessionSchema.nullable(),
  loginChallengePending: z.boolean(),
});
export const loginChallengeSchema = z.object({
  authentication: z.literal('challenge'),
  method: z.enum(['otp', 'totp']),
  expiresAt: z.number().int().positive(),
  otpChannel: z.enum(['sms', 'email']),
  message: z.string().max(500),
  locked: z.boolean(),
  stores: z.array(z.object({ id, name: z.string() })),
});
export const capabilitiesSchema = z.object({
  password: z.boolean(),
});
export const storeSchema = z.object({
  id,
  name: z.string(),
  locationCode: z.string(),
  city: z.string(),
  active: z.boolean(),
});
export const counterSchema = z.object({ id, storeId: id, name: z.string() });
export const productSchema = z.object({
  id,
  name: z.string(),
  erpName: z.string(),
  barcode: z.string().nullable(),
  parentId: id,
  type: z.string(),
  price: money,
  specialPrice: money,
  exclusivePrice: money.nullable(),
  stock: z.number().int(),
  gst: z.number(),
  image: z.url().nullable(),
});
export const orderSchema = z.object({
  id,
  // orders.order_ref_no is nullable in production.
  reference: z.string().nullable(),
  storeId: id,
  customer: z.string(),
  amount: money,
  status: z.string(),
  paymentStatus: z.string(),
  createdAt: z.string(),
});
export const draftSchema = z.object({
  id: z.uuid(),
  storeId: id,
  counterId: id,
  customerId: id.nullable(),
  version: z.number().int().min(0),
  lines: z
    .array(
      z.object({
        productId: id,
        name: z.string(),
        barcode: z.string().nullable(),
        unitPrice: money,
        quantity: z.number().int().min(1).max(999),
      }),
    )
    .max(100),
});
export const storeListSchema = z.object({ data: z.array(storeSchema) });
export const counterListSchema = z.object({ data: z.array(counterSchema) });
export const productPageSchema = z.object({
  data: z.array(productSchema),
  nextCursor: id.nullable(),
});
export const orderPageSchema = z.object({ data: z.array(orderSchema), nextCursor: id.nullable() });
export const orderDetailSchema = z.object({
  reference: z.string().nullable(),
  amount: z.number(),
  isPaid: z.boolean(),
  status: z.string().nullable(),
  createdAt: z.string(),
  lines: z.array(
    z.object({
      id,
      productId: id,
      name: z.string().nullable(),
      quantity: id,
      amount: z.number(),
      gst: z.number(),
      // has_products.status is nullable in production.
      status: z.string().nullable(),
    }),
  ),
});
