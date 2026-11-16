import { and, asc, eq, or, sql } from 'drizzle-orm';
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
import { checkoutOperations, checkoutSessions, customerLeases, giftCardLeases } from './schema.js';
import {
  checkoutStateSchema,
  type CheckoutRepository,
  type CustomerIdentity,
  type MutationResult,
  type OperationReceipt,
} from './contracts.js';
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
export function checkoutRepository(db: Databases): CheckoutRepository {
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
  const sessionWhere = (operatorId: string, storeId: string, id: string) =>
    and(
      eq(checkoutSessions.id, id),
      eq(checkoutSessions.operatorId, operatorId),
      eq(checkoutSessions.storeId, storeId),
    );
  const receipt = (row: typeof checkoutOperations.$inferSelect): OperationReceipt => ({
    id: row.id,
    checkoutId: row.checkoutId,
    status: row.status as OperationReceipt['status'],
    requestHash: row.requestHash,
    result: row.result,
    errorCode: row.errorCode,
  });
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
    async acquireCustomer(checkoutId, customerId) {
      await db.get('writer').transaction(async (tx) => {
        await tx
          .insert(customerLeases)
          .values({ customerId, checkoutId, expiresAt: Date.now() + 12 * 3600000 })
          .onDuplicateKeyUpdate({ set: { customerId } });
        const [lease] = await tx
          .select()
          .from(customerLeases)
          .where(eq(customerLeases.customerId, customerId))
          .for('update');
        if (lease!.checkoutId !== checkoutId && lease!.expiresAt > Date.now())
          throw new AppError(
            409,
            'CUSTOMER_CART_BUSY',
            'This customer already has an active checkout. Finish or review that sale first.',
          );
        await tx
          .update(customerLeases)
          .set({ checkoutId, expiresAt: Date.now() + 12 * 3600000 })
          .where(eq(customerLeases.customerId, customerId));
      });
    },
    async releaseCustomer(checkoutId, customerId) {
      await db
        .get('writer')
        .delete(customerLeases)
        .where(
          and(eq(customerLeases.customerId, customerId), eq(customerLeases.checkoutId, checkoutId)),
        );
    },
    async acquireGiftCard(checkoutId, serial) {
      await db.get('writer').transaction(async (tx) => {
        await tx
          .insert(giftCardLeases)
          .values({ serial, checkoutId, expiresAt: Date.now() + 12 * 3600000 })
          .onDuplicateKeyUpdate({ set: { serial } });
        const [lease] = await tx
          .select()
          .from(giftCardLeases)
          .where(eq(giftCardLeases.serial, serial))
          .for('update');
        if (lease!.checkoutId !== checkoutId && lease!.expiresAt > Date.now())
          throw new AppError(
            409,
            'GIFT_CARD_RESERVED',
            'This card number is reserved by another checkout.',
          );
        await tx
          .update(giftCardLeases)
          .set({ checkoutId, expiresAt: Date.now() + 12 * 3600000 })
          .where(eq(giftCardLeases.serial, serial));
      });
    },
    async releaseGiftCard(checkoutId, serial) {
      await db
        .get('writer')
        .delete(giftCardLeases)
        .where(and(eq(giftCardLeases.serial, serial), eq(giftCardLeases.checkoutId, checkoutId)));
    },
    async create(state) {
      if (!state.draftId)
        throw new AppError(422, 'CHECKOUT_DRAFT_REQUIRED', 'A saved sale identifier is required.');
      return db.get('writer').transaction(async (tx) => {
        await tx
          .insert(checkoutSessions)
          .values({
            id: state.id,
            operatorId: state.operatorId,
            storeId: state.storeId,
            clientDraftId: state.draftId,
            version: state.version,
            state,
          })
          .onDuplicateKeyUpdate({ set: { id: sql`${checkoutSessions.id}` } });
        const [row] = await tx
          .select()
          .from(checkoutSessions)
          .where(
            and(
              eq(checkoutSessions.operatorId, state.operatorId),
              eq(checkoutSessions.clientDraftId, state.draftId!),
            ),
          )
          .limit(1)
          .for('update');
        if (!row)
          throw new AppError(
            409,
            'CHECKOUT_DRAFT_CONFLICT',
            'This saved sale is already bound to another checkout.',
          );
        const existing = checkoutStateSchema.parse(row.state);
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
      });
    },
    async get(operatorId, storeId, id) {
      const [row] = await db
        .get('writer')
        .select({ state: checkoutSessions.state })
        .from(checkoutSessions)
        .where(sessionWhere(operatorId, storeId, id))
        .limit(1);
      return row ? checkoutStateSchema.parse(row.state) : null;
    },
    async begin(operatorId, storeId, id, input, hash, recovery) {
      return db.get('writer').transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(checkoutSessions)
          .where(sessionWhere(operatorId, storeId, id))
          .for('update');
        if (!session)
          throw new AppError(
            404,
            'CHECKOUT_NOT_FOUND',
            'Checkout was not found for this operator and store.',
          );
        const state = checkoutStateSchema.parse(session.state);
        const [existing] = await tx
          .select()
          .from(checkoutOperations)
          .where(
            and(
              eq(checkoutOperations.checkoutId, id),
              eq(checkoutOperations.id, input.operationId),
            ),
          );
        // The existing session row above serializes every operation writer for
        // this checkout. Locking a missing operation also takes a shared gap
        // lock and can deadlock inserts for unrelated checkout IDs.
        if (existing) {
          if (existing.requestHash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This operation key was used with different data.',
            );
          if (!recovery || recoveryReplay(state, receipt(existing), recovery))
            return { state, receipt: receipt(existing), replay: true };
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
        const [origin] =
          recovery?.purpose === 'registration-request' && state.registrationId
            ? await tx
                .select()
                .from(checkoutOperations)
                .where(
                  and(
                    eq(checkoutOperations.checkoutId, id),
                    eq(checkoutOperations.id, state.registrationId),
                  ),
                )
                .limit(1)
            : [];
        const next = recovery
          ? recovery.purpose === 'registration-request'
            ? reserveRegistrationRequestRecovery(
                state,
                input.operationId,
                recovery,
                origin ? receipt(origin) : null,
              )
            : reserveConfirmationRecovery(state, input.operationId, recovery)
          : { ...state, busyOperationId: input.operationId, updatedAt: Date.now() };
        if (recovery && state.busyOperationId && state.busyOperationId !== input.operationId)
          await tx
            .update(checkoutOperations)
            .set({
              status: 'uncertain',
              errorCode:
                recovery.purpose === 'registration-request'
                  ? 'CUSTOMER_REGISTRATION_REQUEST_RECOVERING'
                  : 'CHECKOUT_CONFIRMATION_RECONCILING',
            })
            .where(
              and(
                eq(checkoutOperations.checkoutId, id),
                eq(checkoutOperations.id, state.busyOperationId),
              ),
            );
        if (existing)
          await tx
            .update(checkoutOperations)
            .set({ status: 'inflight', errorCode: null })
            .where(
              and(
                eq(checkoutOperations.checkoutId, id),
                eq(checkoutOperations.id, input.operationId),
              ),
            );
        else
          await tx.insert(checkoutOperations).values({
            checkoutId: id,
            id: input.operationId,
            status: 'inflight',
            requestHash: hash,
          });
        await tx.update(checkoutSessions).set({ state: next }).where(eq(checkoutSessions.id, id));
        return {
          state: next,
          receipt: {
            id: input.operationId,
            checkoutId: id,
            status: 'inflight',
            requestHash: hash,
            result: null,
            errorCode: null,
          },
          replay: false,
        };
      });
    },
    async checkpoint(state, operationId) {
      await db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(checkoutSessions)
          .where(sessionWhere(state.operatorId, state.storeId, state.id))
          .for('update');
        if (
          !row ||
          !currentCheckoutOperation(checkoutStateSchema.parse(row.state), state, operationId)
        )
          throw new AppError(
            409,
            'CHECKOUT_OPERATION_CHANGED',
            'This checkout operation is no longer active.',
          );
        await tx
          .update(checkoutSessions)
          .set({ state: { ...state, busyOperationId: operationId, updatedAt: Date.now() } })
          .where(eq(checkoutSessions.id, state.id));
        if (state.phase === 'cleared') {
          await tx.delete(customerLeases).where(eq(customerLeases.checkoutId, state.id));
          await tx.delete(giftCardLeases).where(eq(giftCardLeases.checkoutId, state.id));
        }
      });
    },
    async finish(state, operationId, result) {
      return db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(checkoutSessions)
          .where(sessionWhere(state.operatorId, state.storeId, state.id))
          .for('update');
        if (
          !row ||
          !currentCheckoutOperation(checkoutStateSchema.parse(row.state), state, operationId)
        )
          throw new AppError(
            409,
            'CHECKOUT_OPERATION_CHANGED',
            'This checkout operation is no longer active.',
          );
        const next = {
          ...state,
          version: row.version + 1,
          busyOperationId: null,
          confirmationRecovery: null,
          registrationRecovery: null,
          updatedAt: Date.now(),
        };
        const response: MutationResult = { state: next, result };
        await tx
          .update(checkoutSessions)
          .set({ version: next.version, state: next })
          .where(eq(checkoutSessions.id, state.id));
        await tx
          .update(checkoutOperations)
          .set({ status: 'succeeded', result: response, errorCode: null })
          .where(
            and(
              eq(checkoutOperations.checkoutId, state.id),
              eq(checkoutOperations.id, operationId),
            ),
          );
        const originalOperationId = state.confirmationRecovery
          ? state.orderSubmissionOperationId
          : state.registrationRecovery
            ? state.registrationId
            : null;
        if (originalOperationId && originalOperationId !== operationId)
          await tx
            .update(checkoutOperations)
            .set({ status: 'succeeded', result: response, errorCode: null })
            .where(
              and(
                eq(checkoutOperations.checkoutId, state.id),
                eq(checkoutOperations.id, originalOperationId),
              ),
            );
        return response;
      });
    },
    async fail(state, operationId, uncertain, errorCode) {
      await db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(checkoutSessions)
          .where(sessionWhere(state.operatorId, state.storeId, state.id))
          .for('update');
        if (
          !row ||
          !currentCheckoutOperation(checkoutStateSchema.parse(row.state), state, operationId)
        )
          return;
        const current = checkoutStateSchema.parse(row.state);
        await tx
          .update(checkoutSessions)
          .set({
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
          })
          .where(eq(checkoutSessions.id, state.id));
        await tx
          .update(checkoutOperations)
          .set({ status: uncertain ? 'uncertain' : 'rejected', errorCode })
          .where(
            and(
              eq(checkoutOperations.checkoutId, state.id),
              eq(checkoutOperations.id, operationId),
            ),
          );
      });
    },
    async reconcileCustomerVerification(operatorId, storeId, id, input, evidence) {
      return db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(checkoutSessions)
          .where(sessionWhere(operatorId, storeId, id))
          .for('update');
        if (!row) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'Checkout was not found.');
        const state = checkoutStateSchema.parse(row.state),
          [original] = await tx
            .select()
            .from(checkoutOperations)
            .where(
              and(
                eq(checkoutOperations.checkoutId, id),
                eq(checkoutOperations.id, input.operationId),
              ),
            )
            .limit(1);
        if (!original)
          throw new AppError(
            404,
            'CHECKOUT_OPERATION_NOT_FOUND',
            'The original verification action was not found.',
          );
        const originalReceipt = receipt(original);
        if (originalReceipt.status === 'succeeded' || originalReceipt.status === 'rejected')
          return { state, receipt: originalReceipt };
        if (!state.customerId)
          throw new AppError(409, 'CUSTOMER_REQUIRED', 'Connect a customer first.');
        const current =
            evidence.kind === 'revoked'
              ? null
              : await readCustomerContactBinding(tx, state.customerId),
          repaired = reconcileCustomerVerificationState(
            state,
            originalReceipt,
            input,
            evidence,
            current,
            Date.now(),
          );
        await tx
          .update(checkoutSessions)
          .set({ state: repaired.state, version: repaired.state.version })
          .where(eq(checkoutSessions.id, id));
        await tx
          .update(checkoutOperations)
          .set({
            status: repaired.receipt.status,
            result: repaired.receipt.result,
            errorCode: repaired.receipt.errorCode,
          })
          .where(
            and(
              eq(checkoutOperations.checkoutId, id),
              eq(checkoutOperations.id, input.operationId),
            ),
          );
        return repaired;
      });
    },
    async operation(operatorId, storeId, id, operationId) {
      const [row] = await db
        .get('writer')
        .select({ operation: checkoutOperations })
        .from(checkoutOperations)
        .innerJoin(checkoutSessions, eq(checkoutSessions.id, checkoutOperations.checkoutId))
        .where(and(sessionWhere(operatorId, storeId, id), eq(checkoutOperations.id, operationId)))
        .limit(1);
      return row ? receipt(row.operation) : null;
    },
  };
}
