import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { HasProduct, MUser, Order, OrderStore, PosUser, Store } from '../../../db/legacy-schema.js';
import { operatorAuthEpochs } from '../../../auth/revocation.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction, checkInService } from '../../administration/checkins.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkoutSessions } from '../schema.js';
import { checkoutStateSchema, type CheckoutState } from '../contracts.js';
import type { Payload } from '../payloads.js';
import { publicScreeningBenefitsContract } from './benefit-contracts.js';
import { readPublicBenefits } from './benefits.js';
import {
  screeningPortableHash,
  screeningQuoteSnapshot,
  nodeScreeningWriterSchema,
  type NodeScreeningWriterCapability,
} from './capability.js';
import { publicScreeningWork } from './schema.js';
import {
  publicScreeningHash,
  readPublicScreeningCreation,
  screeningReconciliationRequired,
  type PublicScreeningCreation,
} from './proof.js';
import { equalImportHash } from '../../legacy-order-imports/financial-adapter-crypto.js';
import {
  lockScreeningCustomer,
  assertScreeningCustomer,
} from '../../legacy-order-imports/screening-transactions.js';
import {
  screeningPurchases,
  screeningReservations,
  screeningReservationSchema,
  screeningProof,
} from '../../legacy-order-imports/screening-profile.js';

export function requiresPublicScreening(cart: unknown): boolean {
  const result = z
    .object({ products: z.object({ items: z.array(z.record(z.string(), z.unknown())) }) })
    .safeParse(cart);
  return (
    result.success && result.data.products.items.some((row) => String(row.prod_id) === '390238')
  );
}
/** The pinned MetaInitializers.make_payment_details mutates the original body
 * before ValidateCheckout by adding the native payment-method ID. Supplying
 * that same source ID up front preserves the exact signed request through the
 * source initializer; a changed native lookup still fails the source hash. */
export function publicScreeningOrderPayload(payload: Payload): Payload {
  const id =
    payload.payment_method === 'coc' ? 14 : payload.payment_method === 'prepaid' ? 3 : null;
  if (id === null || payload.is_pos !== true || (payload.id !== undefined && payload.id !== id))
    throw screeningReconciliationRequired();
  return { ...payload, id };
}
export function assertPublicScreeningVariant(
  state: CheckoutState,
  benefitsContract?: string,
): void {
  const cart = state.quote ?? state.cart;
  const parsed = z
    .object({
      products: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
      giftvouchers: z.object({ items: z.array(z.unknown()) }).optional(),
      complementary_products: z
        .object({ items: z.array(z.record(z.string(), z.unknown())) })
        .optional(),
      meta: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
    })
    .parse(cart);
  const products = [...parsed.products.items, ...(parsed.complementary_products?.items ?? [])];
  if (benefitsContract === publicScreeningBenefitsContract) {
    const members = products.filter((row) => Number(row.prod_type) === 5);
    if (
      members.length > 1 ||
      members.some((row) => Number(row.quantity) !== 1) ||
      (parsed.giftvouchers?.items.length ?? 0) > 100
    )
      throw screeningReconciliationRequired();
    return;
  }
  if (parsed.giftvouchers?.items.length || products.some((row) => Number(row.prod_type) === 8))
    throw new AppError(
      409,
      'SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED',
      'Gift card issuance cannot be combined with screening in this checkout.',
    );
  const exclusive = parsed.meta.items.find((row) => row.name === 'exclusive_user');
  // Source membership constructors/automatic additions require their separate
  // combined producer. Refuse before dispatch rather than rely on a late 4xx.
  if (
    products.some((row) => Number(row.prod_type) === 5) ||
    (exclusive && !exclusive.store_exclusive && exclusive.cart)
  )
    throw new AppError(
      409,
      'SCREENING_MEMBERSHIP_PROFILE_REQUIRED',
      'New or upgraded membership cannot be combined with screening in this checkout.',
    );
}
export function screeningVerificationKey(key: string | undefined): string {
  if (!key || !/^[!-~]{32,4096}$/.test(key))
    throw new AppError(
      503,
      'SCREENING_VERIFICATION_UNAVAILABLE',
      'Retained screening evidence must be verified before continuing.',
    );
  return key;
}
export async function lockPublicActor(tx: AdministrationTransaction, actor: string) {
  const [row] = await tx
    .select({ active: PosUser.is_active })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(actor)))
    .limit(1)
    .for('share');
  await tx
    .select({ epoch: operatorAuthEpochs.epoch })
    .from(operatorAuthEpochs)
    .where(eq(operatorAuthEpochs.userId, actor))
    .limit(1)
    .for('share');
  return row;
}
export async function lockPublicStore(tx: AdministrationTransaction, store: string) {
  const [row] = await tx
    .select({ id: Store.id })
    .from(Store)
    .where(eq(Store.id, BigInt(store)))
    .limit(1)
    .for('update');
  if (!row) throw screeningReconciliationRequired();
}
export async function lockPublicRequest(
  tx: AdministrationTransaction,
  user: Principal,
  store: string,
  counter: string | undefined,
  checkins: Pick<ReturnType<typeof checkInService>, 'assertCheckIn'>,
) {
  const actor = await lockPublicActor(tx, user.id);
  if (!actor?.active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  await lockPublicStore(tx, store);
  await assertCurrentStoreAccess(tx, user.id, store);
  await checkins.assertCheckIn(user.id, store, counter, tx);
}
export async function readPublicIntent(
  tx: AdministrationTransaction,
  operationId: string,
  key: string,
) {
  const [row] = await tx
    .select()
    .from(publicScreeningWork)
    .where(eq(publicScreeningWork.operationId, operationId))
    .limit(1)
    .for('update');
  if (!row) return null;
  const value = nodeScreeningWriterSchema.parse(row.data);
  if (
    row.operationId !== value.operationId ||
    row.actorId !== value.actorId ||
    row.storeId !== value.storeId ||
    row.checkoutId !== value.checkoutId ||
    !equalImportHash(publicScreeningHash(key, 'intent', value), row.proofHash)
  )
    throw screeningReconciliationRequired();
  return { row, value };
}
export function matchesPublicCreation(
  creation: PublicScreeningCreation,
  intent: NodeScreeningWriterCapability,
) {
  return (
    creation.operationId === intent.operationId &&
    creation.checkoutId === intent.checkoutId &&
    creation.checkoutVersion === intent.checkoutVersion &&
    creation.actorId === intent.actorId &&
    creation.customerId === intent.customerId &&
    creation.storeId === intent.storeId &&
    creation.counterId === intent.counterId &&
    creation.requestHash === intent.requestHash &&
    creation.cartHash === intent.cartHash &&
    creation.actorVersion === intent.actorVersion &&
    creation.actorEpoch === intent.actorEpoch &&
    creation.contact.revision === intent.contact.revision &&
    creation.contact.digest === intent.contact.digest &&
    Boolean(creation.benefitsHash) === Boolean(intent.benefitsContract) &&
    creation.createdAt >= intent.issuedAt &&
    creation.createdAt < intent.expiresAt
  );
}
export async function lockPublicCheckout(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
) {
  const [row] = await tx
    .select()
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, creation.checkoutId))
    .limit(1)
    .for('update');
  if (!row) throw screeningReconciliationRequired();
  const state = checkoutStateSchema.parse(row.state);
  if (
    state.id !== creation.checkoutId ||
    state.operatorId !== creation.actorId ||
    state.storeId !== creation.storeId ||
    state.counterId !== creation.counterId ||
    (state.customerId ?? state.operatorCustomerId) !== creation.customerId ||
    state.screeningAdmission?.operationId !== creation.operationId ||
    (state.orderId !== null && state.orderId !== creation.orderId)
  )
    throw screeningReconciliationRequired();
  // This comparison is only meaningful while the original quote is retained.
  if (
    !state.quote ||
    screeningPortableHash(screeningQuoteSnapshot(state.quote)) !== creation.cartHash
  )
    throw screeningReconciliationRequired();
  return { row, state };
}
/** Must be called under Store and before the first native Order lock. */
export async function lockPublicCreation(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  key: string,
) {
  const checkout = await lockPublicCheckout(tx, creation);
  const intent = await readPublicIntent(tx, creation.operationId, key);
  if (!intent || !matchesPublicCreation(creation, intent.value))
    throw screeningReconciliationRequired();
  await lockScreeningCustomer(tx, creation.customerId);
  return { creation, intent, checkout };
}
/** Nonlocking current hint inside the owned READ COMMITTED transaction.
 * It never obtains a second pool connection while financial locks are held. */
export async function publicOrderHint(
  tx: AdministrationTransaction,
  storeId: string,
  orderId: string,
) {
  const [row] = await tx
    .select({ customerId: Order.user, storeId: OrderStore.store })
    .from(Order)
    .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
    .where(and(eq(Order.id, BigInt(orderId)), eq(OrderStore.store, BigInt(storeId))))
    .limit(1);
  if (!row) return null;
  const [ticket] = await tx
    .select({ id: HasProduct.id })
    .from(HasProduct)
    .where(and(eq(HasProduct.order, BigInt(orderId)), eq(HasProduct.product, 390238n)))
    .limit(1);
  return ticket ? { customerId: String(row.customerId), storeId: String(row.storeId) } : null;
}
export async function creationForPublicOrder(
  tx: AdministrationTransaction,
  orderId: string,
  key: string,
) {
  const [raw] = await tx.execute(
    sql`SELECT operation_id FROM pos_rewrite_public_screening_orders WHERE order_id=${orderId} LIMIT 1 FOR SHARE`,
  );
  const records = z
    .array(z.object({ operation_id: z.uuid() }))
    .max(1)
    .parse(raw);
  if (!records.length) throw screeningReconciliationRequired();
  const creation = await readPublicScreeningCreation(tx, records[0]!.operation_id, key);
  if (!creation || creation.orderId !== orderId) throw screeningReconciliationRequired();
  return creation;
}
export async function verifyPublicStructure(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  key: string,
) {
  assertScreeningCustomer(tx, creation.customerId);
  await readPublicBenefits(tx, creation, key);
  const [order] = await tx
    .select({ customer: Order.user, method: Order.payment_methods })
    .from(Order)
    .where(eq(Order.id, BigInt(creation.orderId)))
    .limit(1)
    .for('update');
  if (
    !order ||
    String(order.customer) !== creation.customerId ||
    Number(order.method) !== creation.method
  )
    throw screeningReconciliationRequired();
  const mappings = await tx
    .select({ store: OrderStore.store, counter: OrderStore.counter })
    .from(OrderStore)
    .where(eq(OrderStore.order, BigInt(creation.orderId)))
    .limit(2)
    .for('share');
  if (
    mappings.length !== 1 ||
    String(mappings[0]!.store) !== creation.storeId ||
    String(mappings[0]!.counter) !== creation.counterId
  )
    throw screeningReconciliationRequired();
  const lines = await tx
    .select({ id: HasProduct.id, quantity: HasProduct.qty, sub: HasProduct.sub_prod_id })
    .from(HasProduct)
    .where(and(eq(HasProduct.order, BigInt(creation.orderId)), eq(HasProduct.product, 390238n)))
    .orderBy(asc(HasProduct.id))
    .limit(3);
  const markers = await tx
    .select()
    .from(screeningPurchases, { forceIndex: 'idx_order_id' })
    .where(eq(screeningPurchases.orderId, BigInt(creation.orderId)))
    .orderBy(asc(screeningPurchases.id))
    .limit(3);
  if (
    lines.some((row) => row.sub !== 0n) ||
    markers.some((row) => String(row.customerId) !== creation.customerId) ||
    JSON.stringify(lines.map((row) => ({ id: String(row.id), quantity: Number(row.quantity) }))) !==
      JSON.stringify(creation.lines) ||
    JSON.stringify(markers.map((row) => ({ id: String(row.id), lineId: String(row.lineId) }))) !==
      JSON.stringify(creation.markers)
  )
    throw screeningReconciliationRequired();
  const [row] = await tx
    .select()
    .from(screeningReservations)
    .where(eq(screeningReservations.operationId, creation.operationId))
    .limit(1)
    .for('update');
  if (!row) throw screeningReconciliationRequired();
  const value = screeningReservationSchema.parse(row.data);
  if (
    value.kind !== 'pos' ||
    !['BOUND', 'COUNTED'].includes(value.phase) ||
    value.orderId !== creation.orderId ||
    value.customerId !== creation.customerId ||
    value.scope.actorId !== creation.actorId ||
    value.scope.storeId !== creation.storeId ||
    value.scope.counterId !== creation.counterId ||
    value.requestHash !== creation.requestHash ||
    value.catalogHash !== creation.cartHash ||
    value.lineItemsEnabled !== creation.lineItemsEnabled ||
    JSON.stringify(value.lines) !== JSON.stringify(creation.lines) ||
    JSON.stringify(value.markers) !== JSON.stringify(creation.markers) ||
    value.sourceReceiptHash !== publicScreeningHash(key, 'creation', creation) ||
    !equalImportHash(screeningProof(key, 'state', value), row.proofHash)
  )
    throw screeningReconciliationRequired();
  return { row, value };
}
export async function activePublicCustomer(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
) {
  const [row] = await tx
    .select({ active: MUser.status, blocked: MUser.is_block, disabled: MUser.is_disabled })
    .from(MUser)
    .where(eq(MUser.id, BigInt(creation.customerId)))
    .limit(1)
    .for('update');
  if (
    !row ||
    row.active !== 1 ||
    (row.blocked !== null && row.blocked !== 0) ||
    (row.disabled !== null && row.disabled !== 0)
  )
    throw new AppError(
      409,
      'SCREENING_CUSTOMER_CHANGED',
      'This customer needs review before another payment can be accepted.',
    );
}
