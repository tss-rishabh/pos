import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { discountMetadataSchema, type DiscountMetadata } from './discounts/policy.js';
import { settlementNoteSchema, type SettlementNote } from './settlement-note.js';
import {
  customerContactBindingSchema,
  type CustomerContactBinding,
} from './customer-contact-authority.js';
import { customerConsentSchema, type CustomerConsent } from './customer-consent.js';
import type { CustomerVerificationEvidence } from './customer-verification.js';
import { copyBindingSchema, type CopyBinding } from './order-copy/contracts.js';

export const amountSchema = z
  .string()
  .max(16)
  .regex(/^\d+(?:\.\d{1,2})?$/);
export const mutationSchema = z.object({
  operationId: z.uuid(),
  expectedVersion: z.number().int().min(0),
});
export const cartSchema = z
  .object({
    products: z
      .object({ items: z.array(z.record(z.string(), z.unknown())).max(500) })
      .passthrough(),
    giftvouchers: z
      .object({ items: z.array(z.record(z.string(), z.unknown())).max(100) })
      .passthrough()
      .optional(),
    complementary_products: z
      .object({ items: z.array(z.record(z.string(), z.unknown())).max(500) })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Cart = z.infer<typeof cartSchema>;
export const draftLineItemsSchema = z
  .array(z.object({ productId: identifier, quantity: z.number().int().min(1).max(999) }).strict())
  .max(500)
  .refine(
    (lines) => new Set(lines.map((line) => line.productId)).size === lines.length,
    'A saved sale may contain each product only once.',
  );
export type DraftLineItem = z.infer<typeof draftLineItemsSchema>[number];
export const orderNotificationsSchema = z
  .object({ sendSms: z.boolean(), npsFeedback: z.boolean() })
  .strict()
  .refine((value) => !value.npsFeedback || value.sendSms, 'NPS feedback requires an order SMS.');
export const draftImportSchema = z.object({
  lineItems: draftLineItemsSchema,
  completedProductIds: z.array(identifier).max(500),
  status: z.enum(['pending', 'complete']),
});
export const checkoutClearanceSchema = z
  .object({
    status: z.literal('cleared'),
    checkoutId: z.uuid(),
    operationId: z.uuid(),
    operatorId: identifier,
    storeId: identifier,
    counterId: identifier,
    draftId: z.uuid(),
    draftVersion: z.number().int().nonnegative(),
    reason: z.enum(['cart-clear', 'customer-detach']),
    clearedAt: z.number().int().positive(),
  })
  .strict();
export type CheckoutClearance = z.infer<typeof checkoutClearanceSchema>;
export interface CheckoutState {
  orderCopy?: CopyBinding | null;
  id: string;
  draftId?: string | null;
  draftVersion?: number | null;
  draftImport?: z.infer<typeof draftImportSchema> | null;
  orderNotifications?: z.infer<typeof orderNotificationsSchema> | null;
  settlementNote?: SettlementNote | null;
  operatorId: string;
  operatorCustomerId: string;
  storeId: string;
  counterId: string;
  tabId: number;
  customerId: string | null;
  verifiedCustomerUntil: number | null;
  verifiedCustomerContact?: CustomerContactBinding | null;
  orderCustomerConsent?: CustomerConsent | null;
  verificationChallenge: {
    id: string;
    expiresAt: number;
    attempts: number;
    lastSentAt: number;
    sent: boolean;
    contact?: CustomerContactBinding | null;
    deliveryStatus?: 'pending' | 'sent' | 'uncertain' | 'rejected' | null;
    requestOperationId?: string | null;
    verifyOperationId?: string | null;
  } | null;
  version: number;
  phase: 'open' | 'quoted' | 'order-created' | 'submitted' | 'uncertain' | 'cleared';
  lastClear?: CheckoutClearance | null;
  cart: Cart | null;
  quote: Record<string, unknown> | null;
  orderId: string | null;
  orderSubmissionOperationId: string | null;
  paymentConfirmation: Record<string, unknown> | null;
  confirmationPhase?: 'not-dispatched' | 'dispatching' | 'acknowledged' | null;
  salespersonId: string | null;
  lineSalespersons: Record<string, string>;
  giftCards: Record<string, { number: string; startDate: string; endDate: string }>;
  giftCardDates?: Record<string, { startDate: string; endDate: string }>;
  giftCardValues?: Record<string, number>;
  discountMetadata?: DiscountMetadata;
  busyOperationId: string | null;
  confirmationRecovery?: { leaseId: string; expiresAt: number } | null;
  registrationRecovery?: { leaseId: string; expiresAt: number } | null;
  registrationId?: string | null;
  createdAt: number;
  updatedAt: number;
}
export const checkoutStateSchema: z.ZodType<CheckoutState> = z.object({
  orderCopy: copyBindingSchema.nullable().default(null),
  id: z.uuid(),
  draftId: z.uuid().nullable().default(null),
  draftVersion: z.number().int().nonnegative().nullable().default(null),
  draftImport: draftImportSchema.nullable().default(null),
  orderNotifications: orderNotificationsSchema.nullable().default(null),
  settlementNote: settlementNoteSchema.nullable().default(null),
  operatorId: identifier,
  operatorCustomerId: identifier,
  storeId: identifier,
  counterId: identifier,
  tabId: z.number().int().positive().safe(),
  customerId: identifier.nullable(),
  verifiedCustomerUntil: z.number().nullable(),
  verifiedCustomerContact: customerContactBindingSchema.nullable().default(null),
  orderCustomerConsent: customerConsentSchema.nullable().default(null),
  verificationChallenge: z
    .object({
      id: z.uuid(),
      expiresAt: z.number(),
      attempts: z.number().int().min(0).max(5),
      lastSentAt: z.number(),
      sent: z.boolean(),
      contact: customerContactBindingSchema.nullable().default(null),
      deliveryStatus: z.enum(['pending', 'sent', 'uncertain', 'rejected']).nullable().default(null),
      requestOperationId: z.uuid().nullable().default(null),
      verifyOperationId: z.uuid().nullable().default(null),
    })
    .nullable()
    .default(null),
  version: z.number().int().min(0),
  phase: z.enum(['open', 'quoted', 'order-created', 'submitted', 'uncertain', 'cleared']),
  lastClear: checkoutClearanceSchema.nullable().optional(),
  cart: cartSchema.nullable(),
  quote: z.record(z.string(), z.unknown()).nullable(),
  orderId: identifier.nullable(),
  orderSubmissionOperationId: z.uuid().nullable().default(null),
  paymentConfirmation: z.record(z.string(), z.unknown()).nullable(),
  confirmationPhase: z
    .enum(['not-dispatched', 'dispatching', 'acknowledged'])
    .nullable()
    .default(null),
  salespersonId: identifier.nullable(),
  lineSalespersons: z.record(identifier, identifier),
  giftCards: z.record(
    z.string(),
    z.object({ number: z.string(), startDate: z.string(), endDate: z.string() }),
  ),
  busyOperationId: z.uuid().nullable(),
  confirmationRecovery: z
    .object({ leaseId: z.uuid(), expiresAt: z.number().int().positive() })
    .nullable()
    .optional(),
  registrationId: z.uuid().nullable().optional(),
  registrationRecovery: z
    .object({ leaseId: z.uuid(), expiresAt: z.number().int().positive() })
    .nullable()
    .optional(),
  discountMetadata: discountMetadataSchema.default({ pg: null, store: null }),
  giftCardDates: z
    .record(identifier, z.object({ startDate: z.iso.date(), endDate: z.iso.date() }))
    .default({}),
  giftCardValues: z.record(identifier, z.number().int().min(1).max(10000)).default({}),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export interface CustomerIdentity {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  telephone: string;
  twoFactor: boolean;
  exclusive: boolean;
  active: boolean;
}
export type CustomerLookup = Pick<
  CustomerIdentity,
  'id' | 'email' | 'firstName' | 'lastName' | 'telephone' | 'active'
>;
export interface MutationInput {
  operationId: string;
  expectedVersion: number;
}
export interface MutationResult {
  state: CheckoutState;
  result: Record<string, unknown>;
}
export interface PrepaidSettlement {
  status: 'paid';
  source: 'prepaid';
  orderId: string;
  receiptId: string;
  checkoutId: string;
  checkoutOperationId: string;
  transactionId: string;
  cashAmount: '0.00';
  onlineAmount: '0.00';
}
export interface OperationReceipt {
  id: string;
  checkoutId: string;
  status: 'inflight' | 'succeeded' | 'uncertain' | 'rejected';
  requestHash: string;
  result: MutationResult | null;
  errorCode: string | null;
}
export interface CheckoutRepository {
  customerContact(customerId: string): Promise<CustomerContactBinding>;
  counter(storeId: string, counterId: string): Promise<boolean>;
  operatorIdentity(operatorId: string): Promise<CustomerIdentity | null>;
  customer(
    customerId: string,
    consistency?: 'primary' | 'writer',
  ): Promise<CustomerIdentity | null>;
  findCustomer(query: string): Promise<CustomerLookup[]>;
  cartProduct(productId: string): Promise<{ barcode: string | null; type: number } | null>;
  isEmployeeCoupon(code: string): Promise<boolean>;
  giftCardCollection(
    id: string,
  ): Promise<{ size: number; blocked: boolean; printed: boolean } | null>;
  giftCardAvailable(code: string): Promise<boolean>;
  salesperson(storeId: string, salespersonId: string): Promise<boolean>;
  acquireCustomer(checkoutId: string, customerId: string): Promise<void>;
  releaseCustomer(checkoutId: string, customerId: string): Promise<void>;
  acquireGiftCard(checkoutId: string, serial: string): Promise<void>;
  releaseGiftCard(checkoutId: string, serial: string): Promise<void>;
  create(state: CheckoutState): Promise<CheckoutState>;
  get(operatorId: string, storeId: string, checkoutId: string): Promise<CheckoutState | null>;
  begin(
    operatorId: string,
    storeId: string,
    checkoutId: string,
    input: MutationInput,
    hash: string,
    recovery?: { leaseId: string; now: number; purpose?: 'confirmation' | 'registration-request' },
  ): Promise<{ state: CheckoutState; receipt: OperationReceipt; replay: boolean }>;
  checkpoint(state: CheckoutState, operationId: string): Promise<void>;
  finish(
    state: CheckoutState,
    operationId: string,
    result: Record<string, unknown>,
  ): Promise<MutationResult>;
  fail(
    state: CheckoutState,
    operationId: string,
    uncertain: boolean,
    errorCode: string,
  ): Promise<void>;
  reconcileCustomerVerification(
    operatorId: string,
    storeId: string,
    checkoutId: string,
    input: MutationInput,
    evidence: CustomerVerificationEvidence,
  ): Promise<{ state: CheckoutState; receipt: OperationReceipt }>;
  operation(
    operatorId: string,
    storeId: string,
    checkoutId: string,
    operationId: string,
  ): Promise<OperationReceipt | null>;
}
