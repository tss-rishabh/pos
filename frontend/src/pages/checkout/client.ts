import { z } from 'zod';
import { request, post, captureOperatorScope } from '../../api/client';
import {
  recordCustomerConnection,
  recordPerformancePhase,
} from '../../offline/performance/storage';
import { confirmedPaymentSchema } from './receipts';
import { paymentOptionsSchema } from './payments/client';
import { checkoutClearanceSchema } from '../../api/checkout-clearance';
import { copyBindingSchema } from '../order-copy/client';

const cartSchema = z
  .object({
    products: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
    giftvouchers: z.object({ items: z.array(z.record(z.string(), z.unknown())) }).optional(),
    complementary_products: z
      .object({ items: z.array(z.record(z.string(), z.unknown())).max(500) })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const registrationSchema = z.object({
  id: z.uuid(),
  status: z.enum([
    'pending',
    'verified',
    'dispatching',
    'registered',
    'uncertain',
    'expired',
    'locked',
  ]),
  expiresAt: z.number(),
  retryAt: z.number(),
  attemptsRemaining: z.number().int().min(0).max(5),
  customerId: z.string().nullable(),
  verifiedAt: z.number().nullable(),
  deliveries: z.array(z.object({ channel: z.enum(['sms', 'whatsapp']), status: z.string() })),
  /** S36: registered through legacy "Self Verify (Without OTP)"; benefits stay locked. */
  selfVerified: z.boolean().optional(),
});
export type Registration = z.infer<typeof registrationSchema>;
/**
 * Legacy settings flags resolved by the server per request (checkout store category and
 * operator user_type), as `CreateOrderView` passes them to `create_order.html`.
 */
export const checkoutFlagsSchema = z
  .object({
    showCouponModule: z.boolean(),
    showPgDiscountModule: z.boolean(),
    enableOldPgDiscount: z.boolean(),
    enableNewPgDiscount: z.boolean(),
    enableVoucherToMoney: z.boolean(),
    tenPerSwitch: z.boolean(),
  })
  .strict();
export type CheckoutFlags = z.infer<typeof checkoutFlagsSchema>;
export const checkoutSchema = z
  .object({
    id: z.uuid(),
    operatorId: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .optional(),
    draftId: z.uuid().nullable(),
    draftVersion: z.number().int().nonnegative().nullable(),
    orderNotifications: z
      .object({ sendSms: z.boolean(), npsFeedback: z.boolean() })
      .nullable()
      .optional(),
    draftImport: z
      .object({
        lineItems: z.array(
          z.object({ productId: z.string(), quantity: z.number().int().positive() }),
        ),
        completedProductIds: z.array(z.string()),
        status: z.enum(['pending', 'complete']),
      })
      .nullable(),
    storeId: z.string(),
    counterId: z.string(),
    version: z.number().int(),
    customerId: z.string().nullable(),
    salespersonId: z.string().nullable().optional(),
    lineSalespersons: z.record(z.string(), z.string()).optional(),
    settlementNote: z
      .object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        payable: z.string().regex(/^\d{1,8}\.\d{2}$/),
        cashReceived: z.string().regex(/^\d{1,8}\.\d{2}$/),
      })
      .strict()
      .nullable()
      .optional(),
    registrationId: z.uuid().nullable().optional(),
    registration: registrationSchema.nullable().optional(),
    registrationRequestRecovery: z.boolean().optional(),
    verifiedCustomerUntil: z.number().nullable(),
    verificationChallenge: z
      .object({
        id: z.uuid(),
        expiresAt: z.number(),
        attempts: z.number().int().min(0).max(5),
        lastSentAt: z.number(),
        sent: z.boolean(),
        deliveryStatus: z.enum(['pending', 'sent', 'uncertain', 'rejected']).nullable().optional(),
        requestOperationId: z.uuid().nullable().optional(),
        verifyOperationId: z.uuid().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    phase: z.enum(['open', 'quoted', 'order-created', 'submitted', 'uncertain', 'cleared']),
    lastClear: checkoutClearanceSchema.nullable().optional(),
    orderId: z.string().nullable(),
    orderSubmissionOperationId: z.uuid().nullable().optional(),
    confirmationPhase: z
      .enum(['not-dispatched', 'dispatching', 'acknowledged'])
      .nullable()
      .optional(),
    settlement: confirmedPaymentSchema.nullable().optional(),
    cart: cartSchema.nullable(),
    quote: z.record(z.string(), z.unknown()).nullable(),
    quoteDisplay: z
      .object({
        nonCouponDiscount: z
          .string()
          .regex(/^-?\d+(?:\.\d+)?$/)
          .nullable(),
        totalBeforeRounding: z
          .string()
          .regex(/^-?\d+(?:\.\d+)?$/)
          .nullable(),
        cashbackCreditMessage: z.string().max(2000),
      })
      .strict()
      .optional(),
    busyOperationId: z.string().nullable(),
    orderCopy: copyBindingSchema.nullable().optional(),
    giftCards: z.record(
      z.string(),
      z.object({ number: z.string(), startDate: z.string(), endDate: z.string() }),
    ),
    giftCardDates: z
      .record(z.string(), z.object({ startDate: z.iso.date(), endDate: z.iso.date() }))
      .optional(),
    giftCardValues: z.record(z.string(), z.number().int().min(1).max(10000)).optional(),
    flags: checkoutFlagsSchema.optional(),
  })
  .passthrough();
export type Checkout = z.infer<typeof checkoutSchema>;
const replySchema = z.object({
  status: z.enum(['succeeded', 'inflight', 'uncertain', 'rejected']),
  state: checkoutSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  operationId: z.string().optional(),
  errorCode: z.string().nullable().optional(),
});
export type CheckoutReply = z.infer<typeof replySchema>;
export const discountApprovalSchema = z.object({
  status: z.enum(['not-required', 'required', 'pending', 'approved', 'expired', 'locked']),
  amount: z.string(),
  productsTotal: z.string(),
  challengeId: z.uuid().nullable(),
  expiresAt: z.number().nullable(),
  retryAt: z.number().nullable(),
  delivered: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export type DiscountApproval = z.infer<typeof discountApprovalSchema>;
export const customerSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    telephone: z.string(),
  })
  .passthrough();
export type Customer = z.infer<typeof customerSchema>;
export const checkoutBase = (storeId: string) =>
  `/api/v1/stores/${encodeURIComponent(storeId)}/checkout-sessions`;
export const checkoutPath = (checkout: Pick<Checkout, 'storeId' | 'id'>) =>
  `${checkoutBase(checkout.storeId)}/${checkout.id}`;
export const createCheckout = (
  storeId: string,
  counterId: string,
  draftId: string,
  draftVersion: number,
  lineItems: { productId: string; quantity: number }[],
  operatorId: string,
) =>
  post(
    checkoutBase(storeId),
    { counterId, draftId, draftVersion, lineItems },
    checkoutSchema,
    operatorId,
  );
export function assertCheckoutDraft(
  checkout: Checkout,
  draftId: string,
  draftVersion: number,
  lineItems: { productId: string; quantity: number }[],
) {
  const canonical = (lines: { productId: string; quantity: number }[]) =>
    JSON.stringify(
      lines
        .map(({ productId, quantity }) => ({ productId, quantity }))
        .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)),
    );
  if (
    checkout.draftId !== draftId ||
    checkout.draftVersion !== draftVersion ||
    !checkout.draftImport ||
    canonical(checkout.draftImport.lineItems) !== canonical(lineItems)
  )
    throw new Error(
      'This checkout does not match the saved sale. Keep its reference and review the order before continuing.',
    );
}
export const readCheckout = (storeId: string, id: string, operatorId: string) =>
  request(`${checkoutBase(storeId)}/${id}`, { operatorId }, checkoutSchema);
function checkoutOperator(checkout: Checkout): string {
  if (!checkout.operatorId)
    throw new Error('The checkout owner could not be verified. Reload the original sale.');
  return checkout.operatorId;
}
export const readOperation = (checkout: Checkout, operationId: string) =>
  request(
    `${checkoutPath(checkout)}/operations/${operationId}`,
    { operatorId: checkoutOperator(checkout) },
    replySchema,
  );
export const reconcileCustomerVerification = (checkout: Checkout, operationId: string) =>
  post(
    `${checkoutPath(checkout)}/customer-verification/reconciliations`,
    { operationId, expectedVersion: checkout.version },
    replySchema,
    checkoutOperator(checkout),
  );
/** Payment form options for the sale's counter before the order exists (legacy normal path). */
export const readCheckoutPaymentOptions = async (checkout: Checkout) =>
  request(
    `${checkoutPath(checkout)}/payment-options`,
    { operatorId: checkoutOperator(checkout) },
    paymentOptionsSchema.omit({ payable: true }),
  );
export const readDiscountApproval = (checkout: Checkout) =>
  request(
    `${checkoutPath(checkout)}/discount-approval`,
    { operatorId: checkoutOperator(checkout) },
    discountApprovalSchema,
  );
export const readSettlementNote = (checkout: Checkout) =>
  request(
    `${checkoutPath(checkout)}/settlement-note`,
    { operatorId: checkoutOperator(checkout) },
    z
      .object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        payable: z.string().regex(/^\d{1,8}\.\d{2}$/),
        cashReceived: z.string().regex(/^\d{1,8}\.\d{2}$/),
        message: z.string().min(1).max(255),
      })
      .strict()
      .nullable(),
  );
export const mutateCheckout = async (
  checkout: Checkout,
  operationId: string,
  path: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown> = {},
) => {
  const operatorId = checkoutOperator(checkout),
    signal = captureOperatorScope(operatorId),
    started = performance.now();
  const reply = await request(
    `${checkoutPath(checkout)}/${path}`,
    {
      method,
      body: JSON.stringify({ ...body, operationId, expectedVersion: checkout.version }),
      operatorId,
      signal,
    },
    replySchema,
  );
  const state = reply.state;
  if (reply.status === 'succeeded' && state?.draftId && state.operatorId === operatorId) {
    const owner = {
      ownerId: operatorId,
      storeId: state.storeId,
      counterId: state.counterId,
      draftId: state.draftId,
    };
    try {
      if (path === 'customer' || path === 'customer-detachments')
        await recordCustomerConnection(
          { ...owner, checkoutId: state.id, checkoutVersion: state.version },
          operationId,
          path === 'customer' && state.customerId !== null,
          { signal },
        );
      else if (path === 'draft-initializations')
        await recordPerformancePhase(owner, 'add_to_cart', performance.now() - started, { signal });
    } catch {
      /* Optional measurements cannot change an accepted checkout operation. */
    }
  }
  signal.throwIfAborted();
  return reply;
};
export function authoritativeTotal(checkout: Checkout): string | null {
  const meta = checkout.quote?.meta;
  if (typeof meta !== 'object' || meta === null || !('items' in meta) || !Array.isArray(meta.items))
    return null;
  const item: unknown = meta.items.find(
    (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'name' in value &&
      value.name === 'calculations',
  );
  if (typeof item !== 'object' || item === null || !('total' in item)) return null;
  return typeof item.total === 'number' || typeof item.total === 'string'
    ? String(item.total)
    : null;
}

// Only identifiers needed to recover an operation survive a reload. Customer
// information, cart contents, OTPs and gift-card PINs stay out of this storage.
const recoverySchema = z.object({
  checkoutId: z.uuid(),
  pendingOperationId: z.uuid().nullable(),
  draftVersion: z.number().int(),
});
export type CheckoutRecovery = z.infer<typeof recoverySchema>;
const recoveryKey = (ownerId: string, draftId: string) => `souled-checkout:${ownerId}:${draftId}`;
export function recoveryFor(ownerId: string, draftId: string): CheckoutRecovery | null {
  try {
    const raw = localStorage.getItem(recoveryKey(ownerId, draftId));
    if (!raw) return null;
    return recoverySchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
export function saveRecovery(ownerId: string, draftId: string, value: CheckoutRecovery) {
  localStorage.setItem(recoveryKey(ownerId, draftId), JSON.stringify(value));
}
export function clearRecovery(ownerId: string, draftId: string) {
  try {
    localStorage.removeItem(recoveryKey(ownerId, draftId));
  } catch {
    // The durable IndexedDB completion is authoritative; optional identifier
    // cleanup cannot undo an already completed sale when storage is unavailable.
  }
}
