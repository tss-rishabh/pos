import { and, asc, eq, or } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import {
  Coupon,
  GiftCardCollection,
  GiftVoucher,
  ExclusiveUser,
  MUser,
  ProductBarcode,
  Product,
  StoreCounter,
  StoreSalesPerson,
  SalesPerson,
} from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import {
  type CheckoutRepository,
  type CheckoutState,
  type CustomerIdentity,
  type MutationResult,
  type OperationReceipt,
} from './contracts.js';
import type { CheckoutSessionStore } from './session-store.js';
import {
  currentCheckoutOperation,
  recoveryReplay,
  reserveConfirmationRecovery,
} from './confirmation-recovery.js';
import { reserveRegistrationRequestRecovery } from './customers/request-recovery.js';
import { readCustomerContactBinding } from './customer-contact-authority.js';
import { activeCheckoutCustomer } from './customer-access.js';
import {
  customerVerificationOperation,
  reconcileCustomerVerificationState,
} from './customer-verification.js';

const identitySelection = {
  id: MUser.id,
  email: MUser.email,
  firstName: MUser.firstname,
  lastName: MUser.lastname,
  telephone: MUser.telephone,
  twoFactor: MUser.is_two_fa,
  active: MUser.status,
  blocked: MUser.is_block,
  disabled: MUser.is_disabled,
};
type IdentityRow = {
  id: bigint;
  email: string;
  firstName: string;
  lastName: string;
  telephone: string;
  twoFactor: number;
  active: number;
  blocked: number | null;
  disabled: number | null;
};
export function checkoutRepository(
  db: Databases,
  sessions: CheckoutSessionStore,
): CheckoutRepository {
  async function identity(
    row: IdentityRow | undefined,
    consistency: 'primary' | 'writer' = 'primary',
  ): Promise<CustomerIdentity | null> {
    if (!row) return null;
    const [membership] = await db
      .get(consistency)
      .select({ active: ExclusiveUser.is_active })
      .from(ExclusiveUser)
      .where(
        and(eq(ExclusiveUser.entity, row.email), eq(ExclusiveUser.attribute, 'EXCLUSIVE_EXPIRY')),
      )
      .limit(1);
    return {
      ...row,
      id: String(row.id),
      twoFactor: row.twoFactor === 1,
      active: activeCheckoutCustomer(row),
      exclusive: Boolean(membership?.active),
    };
  }
  const operationChanged = () =>
    new AppError(409, 'CHECKOUT_OPERATION_CHANGED', 'This checkout operation is no longer active.');
  return {
    customerContact(customerId) {
      return db
        .get('writer')
        .transaction((transaction) => readCustomerContactBinding(transaction, customerId));
    },
    async counter(storeId, counterId) {
      const [row] = await db
        .get('writer')
        .select({ id: StoreCounter.id })
        .from(StoreCounter)
        .where(
          and(
            eq(StoreCounter.id, BigInt(counterId)),
            eq(StoreCounter.store, BigInt(storeId)),
            eq(StoreCounter.is_active, true),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async operatorIdentity(operatorId) {
      const [row] = await db
        .get('primary')
        .select(identitySelection)
        .from(MUser)
        .where(eq(MUser.pos_admin_id, BigInt(operatorId)))
        .orderBy(asc(MUser.id))
        .limit(1);
      return identity(row);
    },
    async storefrontIdentity(operatorId) {
      const [row] = await db
        .get('primary')
        .select(identitySelection)
        .from(MUser)
        .where(and(eq(MUser.user_type, '8'), eq(MUser.pos_admin_id, BigInt(operatorId))))
        .orderBy(asc(MUser.id))
        .limit(1);
      return identity(row);
    },
    async customer(customerId, consistency = 'primary') {
      const [row] = await db
        .get(consistency)
        .select(identitySelection)
        .from(MUser)
        .where(eq(MUser.id, BigInt(customerId)))
        .limit(1);
      return identity(row, consistency);
    },
    async findCustomer(query) {
      const rows = await db
        .get('primary')
        .select(identitySelection)
        .from(MUser)
        .where(or(eq(MUser.telephone, query), eq(MUser.email, query)))
        .orderBy(asc(MUser.id))
        .limit(10);
      // Lookup does not issue tokens or expose membership. Avoid one membership
      // query per match; attachment rechecks the selected customer on the writer.
      return rows.map((row) => ({
        id: String(row.id),
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        telephone: row.telephone,
        active: activeCheckoutCustomer(row),
      }));
    },
    async cartProduct(productId) {
      const [row] = await db
        .get('primary')
        .select({ barcode: ProductBarcode.gtin, type: Product.prod_type })
        .from(Product)
        .leftJoin(ProductBarcode, eq(ProductBarcode.product, Product.id))
        .where(eq(Product.id, BigInt(productId)))
        .orderBy(asc(ProductBarcode.id))
        .limit(1);
      if (row && !Number.isSafeInteger(Number(row.type)))
        throw new AppError(
          502,
          'PRODUCT_TYPE_UNSUPPORTED',
          'This product type cannot be represented by checkout.',
        );
      return row
        ? { type: Number(row.type), barcode: row.barcode === null ? null : String(row.barcode) }
        : null;
    },
    async isEmployeeCoupon(code) {
      const [row] = await db
        .get('writer')
        .select({ id: Coupon.id })
        .from(Coupon)
        .where(and(eq(Coupon.voucher_code, code), eq(Coupon.is_employee_coupon, 1)))
        .limit(1);
      return Boolean(row);
    },
    async giftCardCollection(id) {
      const [row] = await db
        .get('writer')
        .select({
          size: GiftCardCollection.size,
          blocked: GiftCardCollection.is_block,
          printed: GiftCardCollection.is_printed,
          completed: GiftCardCollection.is_completed,
        })
        .from(GiftCardCollection)
        .where(eq(GiftCardCollection.id, BigInt(id)))
        .limit(1);
      if (
        row &&
        (![0, 1].includes(row.blocked) || ![0, 1].includes(row.printed) || row.completed !== 1)
      )
        throw new AppError(
          409,
          'GIFT_CARD_COLLECTION_UNAVAILABLE',
          'This gift card collection requires review.',
        );
      return row
        ? { size: row.size, blocked: row.blocked === 1, printed: row.printed === 1 }
        : null;
    },
    async giftCardAvailable(code) {
      const [row] = await db
        .get('writer')
        .select({ id: GiftVoucher.id })
        .from(GiftVoucher)
        .where(eq(GiftVoucher.voucher_code, code))
        .limit(1);
      // The physical UNIQUE voucher_code survives order cancellation. Do not
      // promise safe reissuance by treating an existing row as unused.
      return !row;
    },
    async salesperson(storeId, salespersonId) {
      const [row] = await db
        .get('writer')
        .select({ id: StoreSalesPerson.id })
        .from(StoreSalesPerson)
        .innerJoin(SalesPerson, eq(SalesPerson.id, StoreSalesPerson.salesperson))
        .where(
          and(
            eq(StoreSalesPerson.store, BigInt(storeId)),
            eq(StoreSalesPerson.salesperson, BigInt(salespersonId)),
            eq(StoreSalesPerson.is_active, 1),
            eq(SalesPerson.is_active, 1),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    acquireCustomer: (checkoutId, customerId) =>
      sessions.acquireLease('customer', customerId, checkoutId),
    releaseCustomer: (checkoutId, customerId) =>
      sessions.releaseLease('customer', customerId, checkoutId),
    acquireGiftCard: (checkoutId, serial) => sessions.acquireLease('gift-card', serial, checkoutId),
    releaseGiftCard: (checkoutId, serial) => sessions.releaseLease('gift-card', serial, checkoutId),
    async create(state) {
      if (!state.draftId)
        throw new AppError(422, 'CHECKOUT_DRAFT_REQUIRED', 'A saved sale identifier is required.');
      const boundId = await sessions.bindDraft(state.operatorId, state.draftId, state.id);
      if (boundId === state.id) {
        const existing = await sessions.read(state.id);
        if (!existing) await sessions.write(state);
      }
      const existing = await sessions.read(boundId);
      if (!existing)
        throw new AppError(
          409,
          'CHECKOUT_DRAFT_CONFLICT',
          'This saved sale is already bound to another checkout.',
        );
      if (
        existing.operatorId !== state.operatorId ||
        existing.storeId !== state.storeId ||
        existing.counterId !== state.counterId ||
        existing.draftId !== state.draftId
      )
        throw new AppError(
          409,
          'CHECKOUT_DRAFT_SCOPE_CONFLICT',
          'This saved sale is already bound to a different store or counter.',
        );
      if (
        existing.draftVersion !== state.draftVersion ||
        JSON.stringify(existing.draftImport?.lineItems ?? null) !==
          JSON.stringify(state.draftImport?.lineItems ?? null)
      )
        throw new AppError(
          409,
          'CHECKOUT_DRAFT_CONTENT_CONFLICT',
          'This saved sale is already bound to a different review snapshot.',
        );
      return existing;
    },
    get: (operatorId, storeId, id) => sessions.readScoped(operatorId, storeId, id),
    begin(operatorId, storeId, id, input, hash, recovery) {
      type Reservation = { state: CheckoutState; receipt: OperationReceipt; replay: boolean };
      return sessions.exclusive<Reservation>(operatorId, storeId, id, async (state) => {
        const existing = await sessions.receipt(id, input.operationId);
        if (existing) {
          if (existing.requestHash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This operation key was used with different data.',
            );
          if (!recovery || recoveryReplay(state, existing, recovery))
            return { state: null, value: { state, receipt: existing, replay: true } };
        }
        if (state.version !== input.expectedVersion)
          throw new AppError(
            409,
            'CHECKOUT_VERSION_CONFLICT',
            'This checkout changed. Reload it before continuing.',
          );
        if (state.phase === 'cleared')
          throw new AppError(
            409,
            'CHECKOUT_CLEARED',
            'This checkout was cleared. Open a new sale.',
          );
        if (!recovery && (state.busyOperationId || state.phase === 'uncertain'))
          throw new AppError(
            409,
            'CHECKOUT_REVIEW_REQUIRED',
            'A previous checkout operation needs review before continuing.',
          );
        const origin =
          recovery?.purpose === 'registration-request' && state.registrationId
            ? await sessions.receipt(id, state.registrationId)
            : null;
        const next: CheckoutState = recovery
          ? recovery.purpose === 'registration-request'
            ? reserveRegistrationRequestRecovery(state, input.operationId, recovery, origin)
            : reserveConfirmationRecovery(state, input.operationId, recovery)
          : { ...state, busyOperationId: input.operationId, updatedAt: Date.now() };
        if (recovery && state.busyOperationId && state.busyOperationId !== input.operationId) {
          const busy = await sessions.receipt(id, state.busyOperationId);
          if (busy)
            await sessions.saveReceipt({
              ...busy,
              status: 'uncertain',
              errorCode:
                recovery.purpose === 'registration-request'
                  ? 'CUSTOMER_REGISTRATION_REQUEST_RECOVERING'
                  : 'CHECKOUT_CONFIRMATION_RECONCILING',
            });
        }
        const receipt: OperationReceipt = {
          id: input.operationId,
          checkoutId: id,
          status: 'inflight',
          requestHash: hash,
          result: existing?.result ?? null,
          errorCode: null,
        };
        await sessions.saveReceipt(
          existing ? { ...existing, status: 'inflight', errorCode: null } : receipt,
        );
        return {
          state: next,
          value: {
            state: next,
            receipt: { ...receipt, result: null },
            replay: false,
          },
        };
      });
    },
    async checkpoint(state, operationId) {
      await sessions.exclusive(state.operatorId, state.storeId, state.id, async (current) => {
        if (!currentCheckoutOperation(current, state, operationId)) throw operationChanged();
        return {
          state: { ...state, busyOperationId: operationId, updatedAt: Date.now() },
          value: undefined,
        };
      });
      if (state.phase === 'cleared') {
        if (state.customerId) await sessions.releaseLease('customer', state.customerId, state.id);
        for (const card of Object.values(state.giftCards))
          await sessions.releaseLease('gift-card', card.number, state.id);
      }
    },
    finish(state, operationId, result) {
      return sessions.exclusive(state.operatorId, state.storeId, state.id, async (current) => {
        if (!currentCheckoutOperation(current, state, operationId)) throw operationChanged();
        const next: CheckoutState = {
          ...state,
          version: current.version + 1,
          busyOperationId: null,
          confirmationRecovery: null,
          registrationRecovery: null,
          updatedAt: Date.now(),
        };
        const response: MutationResult = { state: next, result };
        const receipt = await sessions.receipt(state.id, operationId);
        await sessions.saveReceipt({
          id: operationId,
          checkoutId: state.id,
          requestHash: receipt?.requestHash ?? '',
          status: 'succeeded',
          result: response,
          errorCode: null,
        });
        const originalOperationId = state.confirmationRecovery
          ? state.orderSubmissionOperationId
          : state.registrationRecovery
            ? state.registrationId
            : null;
        if (originalOperationId && originalOperationId !== operationId) {
          const original = await sessions.receipt(state.id, originalOperationId);
          if (original)
            await sessions.saveReceipt({
              ...original,
              status: 'succeeded',
              result: response,
              errorCode: null,
            });
        }
        return { state: next, value: response };
      });
    },
    async fail(state, operationId, uncertain, errorCode) {
      await sessions
        .exclusive(state.operatorId, state.storeId, state.id, async (current) => {
          if (!currentCheckoutOperation(current, state, operationId))
            return { state: null, value: undefined };
          const receipt = await sessions.receipt(state.id, operationId);
          if (receipt)
            await sessions.saveReceipt({
              ...receipt,
              status: uncertain ? 'uncertain' : 'rejected',
              errorCode,
            });
          return {
            state: {
              ...current,
              busyOperationId: null,
              confirmationRecovery: null,
              registrationRecovery: null,
              phase:
                current.phase === 'cleared'
                  ? 'cleared'
                  : uncertain && !customerVerificationOperation(current, operationId)
                    ? 'uncertain'
                    : current.phase,
              updatedAt: Date.now(),
            },
            value: undefined,
          };
        })
        .catch((error: unknown) => {
          if (!(error instanceof AppError) || error.code !== 'CHECKOUT_NOT_FOUND') throw error;
        });
    },
    reconcileCustomerVerification(operatorId, storeId, id, input, evidence) {
      return sessions.exclusive(operatorId, storeId, id, async (state) => {
        const original = await sessions.receipt(id, input.operationId);
        if (!original)
          throw new AppError(
            404,
            'CHECKOUT_OPERATION_NOT_FOUND',
            'The original verification action was not found.',
          );
        if (original.status === 'succeeded' || original.status === 'rejected')
          return { state: null, value: { state, receipt: original } };
        if (!state.customerId)
          throw new AppError(409, 'CUSTOMER_REQUIRED', 'Connect a customer first.');
        const current =
            evidence.kind === 'revoked'
              ? null
              : await db
                  .get('writer')
                  .transaction((tx) => readCustomerContactBinding(tx, state.customerId!)),
          repaired = reconcileCustomerVerificationState(
            state,
            original,
            input,
            evidence,
            current,
            Date.now(),
          );
        await sessions.saveReceipt(repaired.receipt);
        return { state: repaired.state, value: repaired };
      });
    },
    async operation(operatorId, storeId, id, operationId) {
      if (!(await sessions.readScoped(operatorId, storeId, id))) return null;
      return sessions.receipt(id, operationId);
    },
  };
}
