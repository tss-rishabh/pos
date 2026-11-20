import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { Comments, HasProduct, MUser, Order, Product, Store } from '../../../db/legacy-schema.js';
import { assertCurrentOperatorRole } from '../../administration/authorization.js';
import { requireRole, requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { exchangeRetryable } from '../returns.js';
import { exchangeRefusal } from './exchange-cell.js';
import {
  publicReturn,
  type ExchangeRecoveryScope,
  type ExchangeRecoveryClaim,
  type ReturnWindowScope,
} from './contracts.js';
import {
  fingerprint,
  RECOVERY_CLAIM_TTL_SECONDS,
  returnStateKeys,
  type RecoveryClaimReceipt,
} from './state.js';
import type { ReturnRepositoryCore } from './repository-core.js';

/**
 * Read-side scope: the S35 preflight, the order lines, eligibility, exchange recovery
 * claims and the return-date extension scope.
 */
export function returnScopeOperations(core: ReturnRepositoryCore) {
  const {
    db,
    options,
    state,
    checkIn,
    timestamp,
    stamp,
    context,
    refused,
    guardFacts,
    assertExchangeOffered,
    load,
    phaseOneCommitted,
    exchangeLog,
    phaseOneProof,
    recoverySnapshot,
    recoveryView,
    readClaim,
  } = core;
  return {
    /**
     * S35 preflight, read only: the guard facts and the order's customer, so a refusal that needs
     * the eligibility answer (online type 8 outside the merged cell) happens before any write.
     */
    async exchangePreflight(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      counterId: string,
    ) {
      return db.get('writer').transaction(async (tx) => {
        const scope = await context(tx, user, storeId, orderId, lineId, counterId);
        const facts = await guardFacts(tx, user.id, orderId, scope.line.product);
        const refusal = exchangeRefusal({ ...facts, retry: false, merged: null });
        if (refusal) throw refused(refusal);
        return { ...facts, customerId: String(scope.order.customerId) };
      });
    },
    state,
    load,
    /**
     * The order's lines for the returns page (the `ShowOrderDetailsView` product rows), 100 per
     * page. No customer OTP step, as legacy; the operator must be checked in to this store.
     */
    async lines(user: Principal, storeId: string, orderId: string, counterId: string, after = '0') {
      requireStore(user, storeId);
      return db.get('writer').transaction(async (tx) => {
        await checkIn(user.id, storeId, counterId, tx);
        const [order] = await tx
          .select({ id: Order.id })
          .from(Order)
          .where(eq(Order.id, BigInt(orderId)))
          .limit(1);
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
        const rows = await tx
          .select({
            id: HasProduct.id,
            productId: HasProduct.product,
            name: Product.product,
            parentId: Product.parent_prod_id,
            productType: Product.prod_type,
            quantity: HasProduct.qty,
            status: HasProduct.status,
            returnStatus: HasProduct.return_status,
          })
          .from(HasProduct)
          .leftJoin(Product, eq(Product.id, HasProduct.product))
          .where(and(eq(HasProduct.order, BigInt(orderId)), gt(HasProduct.id, BigInt(after))))
          .orderBy(asc(HasProduct.id))
          .limit(101);
        return {
          data: rows.slice(0, 100).map((row) => ({
            ...row,
            id: String(row.id),
            productId: String(row.productId),
            parentId: String(row.parentId || 0),
            productType: row.productType === null ? null : Number(row.productType),
            quantity: String(row.quantity),
          })),
          nextCursor: rows.length > 100 ? String(rows[99]!.id) : null,
        };
      });
    },
    /** Facts the per-line eligibility response needs to choose the legacy cell branch. */
    async eligibilityScope(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeRecoveryScope,
    ) {
      return db.get('writer').transaction(async (tx) => {
        const scope = await context(tx, user, storeId, orderId, lineId, input.counterId);
        const guard = await guardFacts(tx, user.id, orderId, scope.line.product);
        // get_exchange_context (order/views.py:315-333).
        const log = await exchangeLog(tx, orderId, lineId);
        let failedExchange: { storeId: string; storeName: string; newSize: string } | null = null;
        if (
          log?.status === 'FAILED_NEEDS_MANUAL_FIX' &&
          exchangeRetryable(scope.line.status, Boolean(await phaseOneCommitted(tx, log)))
        ) {
          const [origin] = await tx
            .select({ name: Store.store_name })
            .from(Store)
            .where(eq(Store.id, BigInt(log.store_id)))
            .limit(1);
          failedExchange = {
            storeId: String(log.store_id),
            storeName: origin?.name ?? '',
            newSize: log.new_size ?? 'None',
          };
        }
        return {
          customerId: String(scope.order.customerId),
          lineStatus: scope.line.status,
          returnStatus: scope.line.return_status,
          productType: guard.productType,
          storeOrder: guard.variant === 'store',
          shopifyOrder: guard.shopifyOrder,
          checkinStoreId: guard.checkinStoreId,
          exchangeFeatureEnabled: guard.exchangeFeatureEnabled,
          failedExchange,
          binding: fingerprint('return.eligibility-scope', {
            user: user.id,
            storeId,
            orderId,
            lineId,
            input,
            customerId: scope.order.customerId,
            line: scope.line,
          }),
        };
      });
    },
    async exchangeRecovery(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeRecoveryScope,
    ) {
      return db
        .get('writer')
        .transaction(async (tx) =>
          recoveryView(await recoverySnapshot(tx, user, storeId, orderId, lineId, input), storeId),
        );
    },
    /** Read-only outcome of a lost claim; an actor cannot read another actor's receipt. */
    async exchangeRecoveryClaimStatus(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      claimId: string,
      input: ExchangeRecoveryScope,
    ) {
      // Actor, store and check-in validation of the current reader.
      await db
        .get('writer')
        .transaction((tx) => context(tx, user, storeId, orderId, lineId, input.counterId));
      const receipt = await readClaim(storeId, orderId, lineId, claimId);
      if (!receipt || receipt.operatorId !== user.id || receipt.status !== 'recorded')
        return { status: 'not-recorded' as const };
      const operation = receipt.operationId ? await state.readOperation(receipt.operationId) : null;
      if (
        operation &&
        (operation.orderId !== orderId ||
          operation.lineId !== lineId ||
          operation.storeId !== storeId ||
          operation.kind !== 'exchange')
      )
        throw new AppError(
          409,
          'EXCHANGE_RECOVERY_RECEIPT_CHANGED',
          'The recorded recovery binding needs reconciliation.',
        );
      return { status: 'recorded' as const, operationId: receipt.operationId! };
    },
    /**
     * Explicit takeover of a failed exchange (legacy retry button, order/views.py:1016-1035).
     * Metadata only: no provider, return, refund or stock effect. The durable takeover facts are
     * written by the retry itself (pos_exchange_log.staff_user_id, retry_count).
     */
    async claimExchangeRecovery(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeRecoveryClaim,
    ) {
      const requestHash = fingerprint('exchange.recovery-claim', {
          userId: user.id,
          storeId,
          orderId,
          lineId,
          input,
        }),
        receiptKey = returnStateKeys.claim(storeId, orderId, lineId, input.operationId),
        binding = `${storeId}:${orderId}:${lineId}`;
      const conflict = () =>
        new AppError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This recovery command has different original input. Read its original outcome.',
        );
      if (
        !(await state.store.set(
          returnStateKeys.claimId(input.operationId),
          binding,
          RECOVERY_CLAIM_TTL_SECONDS,
          true,
        )) &&
        (await state.store.get(returnStateKeys.claimId(input.operationId))) !== binding
      )
        throw conflict();
      const pending: RecoveryClaimReceipt = {
        v: 1,
        requestHash,
        operatorId: user.id,
        counterId: input.counterId,
        revision: input.expectedRevision,
        operationId: null,
        status: 'pending',
        recordedAt: null,
      };
      const pendingRaw = JSON.stringify(pending);
      if (!(await state.store.set(receiptKey, pendingRaw, RECOVERY_CLAIM_TTL_SECONDS, true))) {
        const prior = await readClaim(storeId, orderId, lineId, input.operationId);
        if (
          !prior ||
          prior.requestHash !== requestHash ||
          prior.operatorId !== user.id ||
          prior.counterId !== input.counterId
        )
          throw conflict();
        if (prior.status === 'recorded' && prior.operationId) {
          const operation = await state.readOperation(prior.operationId);
          if (!operation)
            throw new AppError(
              409,
              'EXCHANGE_RECOVERY_RECEIPT_CHANGED',
              'The recorded recovery operation needs reconciliation.',
            );
          return publicReturn(operation);
        }
      }
      const adopted = await state.withLine(orderId, lineId, () =>
        db.get('writer').transaction(async (tx) => {
          const snapshot = await recoverySnapshot(tx, user, storeId, orderId, lineId, {
            counterId: input.counterId,
          });
          const { scope, log, credit } = snapshot;
          // S35: the retry button of a failed exchange (order/views.py:1016-1035).
          await assertExchangeOffered(tx, user.id, orderId, scope.line.product, true);
          const claim = {
            id: input.operationId,
            revision: input.expectedRevision,
            operatorId: user.id,
            counterId: input.counterId,
            claimedAt: timestamp(),
            requestHash,
          };
          // A re-run of a pending claim finds its own operation already adopted.
          if (snapshot.operation?.recoveryClaim?.id === input.operationId)
            return snapshot.operation;
          if (snapshot.revision !== input.expectedRevision)
            throw new AppError(
              409,
              'EXCHANGE_RECOVERY_CHANGED',
              'The exchange changed. Read its current recovery status.',
            );
          if (snapshot.operation) {
            const operation = snapshot.operation;
            if (
              ![
                'replacement-rejected',
                'uncertain',
                'old-item-restored',
                'inbound-accepted',
                'replacement-confirmed',
                'completed',
              ].includes(operation.phase)
            )
              throw new AppError(
                409,
                'EXCHANGE_RECOVERY_BUSY',
                'An exchange for this item is already in progress.',
              );
            await phaseOneProof(tx, operation, scope.line.status, operation.phase === 'completed');
            return stamp({
              ...operation,
              authorityCounterId: input.counterId,
              recoveryClaim: claim,
            });
          }
          const view = recoveryView(snapshot, storeId);
          if (view.state === 'wrong-store' && log) {
            const [origin] = await tx
              .select({ name: Store.store_name })
              .from(Store)
              .where(eq(Store.id, BigInt(log.store_id)))
              .limit(1);
            throw new AppError(
              409,
              'EXCHANGE_WRONG_STORE',
              `This exchange was started at ${origin?.name || `store ${log.store_id}`}. Please retry it from there.`,
            );
          }
          if (view.state !== 'legacy' || !log || !credit)
            throw new AppError(
              409,
              'EXCHANGE_RECOVERY_UNCONFIRMED',
              'There is no failed exchange to retry for this item. Please refresh the page.',
            );
          if (!input.salespersonId)
            throw new AppError(
              422,
              'EXCHANGE_SALESPERSON_REQUIRED',
              'Salesperson selection is required for exchange.',
            );
          const date = timestamp();
          return {
            id: input.operationId,
            kind: 'exchange' as const,
            operatorId: user.id,
            storeId,
            orderId,
            lineId,
            productId: String(log.old_prod_id),
            customerId: String(scope.order.customerId),
            quantity: Number(scope.line.qty),
            authorityCounterId: input.counterId,
            recoveryClaim: claim,
            exchange: {
              newProductId: String(log.new_prod_id),
              parentProductId: String(log.exchange_parent_prod_id),
              newSize: log.new_size ?? '',
              oldSize: log.old_size,
              salespersonId: input.salespersonId,
              logId: String(log.id),
              childOrderId: null,
              // order/views.py:1071: counter_id = exchange_log.counter_id or 0
              sourceCounterId: String(log.counter_id || 0),
            },
            input: {
              operationId: input.operationId,
              counterId: input.counterId,
              reasonId: String(log.reason_id),
              ...(log.sub_reason_id ? { subReasonId: String(log.sub_reason_id) } : {}),
              comment: log.comment || '',
              qualityConfirmed: true,
              tagConfirmed: true,
              saleable: Boolean(log.saleable),
              refundMode: 'tss-money' as const,
              overrideEligibility: false,
              clickType: 'normal' as const,
            },
            requestHash,
            phase: 'replacement-rejected' as const,
            uncertainStage: null,
            creditNote: credit.creditNote,
            returnAmount: null,
            returnAmountRepr: null,
            errorCode: 'LEGACY_EXCHANGE_ADOPTED',
            message: log.last_error,
            createdAt: log.created_at,
            updatedAt: date,
          };
        }),
      );
      await state.saveOperation(adopted);
      const recorded: RecoveryClaimReceipt = {
        ...pending,
        operationId: adopted.id,
        status: 'recorded',
        recordedAt: timestamp(),
      };
      const current = await state.store.get(receiptKey);
      if (current !== null && current !== JSON.stringify(recorded))
        await state.store.compareAndSet(
          receiptKey,
          current,
          JSON.stringify(recorded),
          RECOVERY_CLAIM_TTL_SECONDS,
        );
      return publicReturn(adopted);
    },
    async extensionScope(
      tx: AdministrationTransaction,
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ReturnWindowScope,
    ) {
      requireRole(user, [1, 2, 3]);
      await assertCurrentOperatorRole(tx, user.id, [1, 2, 3]);
      const scope = await context(tx, user, storeId, orderId, lineId, input.counterId);
      if (
        String(scope.line.product) !== input.productId ||
        scope.line.status !== 'DELIVERED' ||
        scope.line.return_status !== 0
      )
        throw new AppError(
          409,
          'RETURN_EXTENSION_LINE_INELIGIBLE',
          'Select an unreturned delivered line belonging to this order.',
        );
      const actors = await tx
        .select({ id: MUser.id })
        .from(MUser)
        .where(eq(MUser.pos_admin_id, BigInt(user.id)))
        .limit(2)
        .for('share');
      if (actors.length !== 1 || !actors[0] || actors[0].id <= 0n)
        throw new AppError(
          409,
          'RETURN_EXTENSION_ACTOR_UNAVAILABLE',
          'The native manager audit identity needs review.',
        );
      if (options.returnPeriodDays === undefined)
        throw new AppError(503, 'RETURN_POLICY_UNAVAILABLE', 'Return policy is not configured.');
      const [delivery] = await tx
        .select({ date: Comments.created_at })
        .from(Comments)
        .where(and(eq(Comments.order_id, BigInt(orderId)), eq(Comments.status_id, 3n)))
        .orderBy(desc(Comments.created_at))
        .limit(1)
        .for('share');
      if (!delivery)
        throw new AppError(
          409,
          'RETURN_DELIVERY_UNCONFIRMED',
          'No delivered record exists for this order.',
        );
      return {
        nativeActorId: actors[0].id,
        deliveredAt: delivery.date,
        periodDays: options.returnPeriodDays,
      };
    },
  };
}
