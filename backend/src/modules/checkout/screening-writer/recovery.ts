import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Order } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import type { Principal } from '../../../domain/access.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { lockScreeningCustomer } from '../../legacy-order-imports/screening-transactions.js';
import { checkoutSessions, checkoutOperations } from '../schema.js';
import { checkoutStateSchema } from '../contracts.js';
import type { PublicScreeningCoordinator } from './coordinator.js';
import {
  publicScreeningScopeSchema,
  publicScreeningViewSchema,
  publicScreeningAbandonInputSchema,
  type PublicScreeningScope,
} from './api-contracts.js';
import {
  lockPublicRequest,
  readPublicIntent,
  matchesPublicCreation,
  verifyPublicStructure,
} from './native.js';
import { publicScreeningAbandonment, publicScreeningAbandonmentSchema } from './abandon.js';
import {
  readPublicScreeningCreation,
  publicScreeningHash,
  screeningReconciliationRequired,
} from './proof.js';
import { publicScreeningWork, publicScreeningSubmissionDispatches } from './schema.js';
import { readPublicCompletion } from './settlement.js';
import { readPublicPublication } from './publication.js';
import { equalImportHash } from '../../legacy-order-imports/financial-adapter-crypto.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import {
  readPublicScreeningNegative,
  assertNoPublicScreeningEffects,
  requestPublicScreeningNegative,
} from './negative.js';

export function publicScreeningRecovery(coordinator: PublicScreeningCoordinator) {
  async function scope(
    tx: AdministrationTransaction,
    user: Principal,
    supplied: PublicScreeningScope,
  ) {
    const p = publicScreeningScopeSchema.parse(supplied);
    // Counter is resolved from the locked original checkout, never from a URL
    // or an old principal's cached store assignments.
    await lockPublicRequest(tx, user, p.storeId, undefined, coordinator.checkins);
    await coordinator.session(user, tx);
    const [row] = await tx
      .select()
      .from(checkoutSessions)
      .where(and(eq(checkoutSessions.id, p.checkoutId), eq(checkoutSessions.storeId, p.storeId)))
      .limit(1)
      .for('update');
    if (!row) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'Checkout not found.');
    const state = checkoutStateSchema.parse(row.state);
    if (state.operatorId !== user.id)
      await assertCurrentStoreAccess(tx, user.id, p.storeId, [1, 2, 3]);
    await coordinator.checkins.assertCheckIn(user.id, p.storeId, state.counterId, tx);
    const intent = await readPublicIntent(tx, p.operationId, coordinator.key());
    if (
      !intent ||
      intent.value.checkoutId !== state.id ||
      intent.value.storeId !== state.storeId ||
      intent.value.counterId !== state.counterId ||
      intent.value.actorId !== state.operatorId ||
      (state.customerId ?? state.operatorCustomerId) !== intent.value.customerId ||
      state.screeningAdmission?.operationId !== p.operationId
    )
      throw screeningReconciliationRequired();
    await lockScreeningCustomer(tx, intent.value.customerId);
    const creation = await readPublicScreeningCreation(tx, p.operationId, coordinator.key());
    if (
      creation &&
      (!matchesPublicCreation(creation, intent.value) ||
        (state.orderId !== null && state.orderId !== creation.orderId))
    )
      throw screeningReconciliationRequired();
    await coordinator.session(user, tx);
    return { p, row, state, intent, creation };
  }
  async function abandoned(tx: AdministrationTransaction, operationId: string) {
    const [raw] = await tx.execute(
      sql`SELECT data,proof_hash FROM pos_rewrite_public_screening_abandonments WHERE operation_id=${operationId} LIMIT 1 FOR SHARE`,
    );
    const rows = z
      .array(z.object({ data: z.unknown(), proof_hash: z.string() }))
      .max(1)
      .parse(raw);
    if (!rows.length) return null;
    const value = publicScreeningAbandonmentSchema.parse(
      typeof rows[0]!.data === 'string' ? (JSON.parse(rows[0]!.data) as unknown) : rows[0]!.data,
    );
    if (
      value.operationId !== operationId ||
      !equalImportHash(
        publicScreeningHash(coordinator.key(), 'abandonment', value),
        rows[0]!.proof_hash,
      )
    )
      throw screeningReconciliationRequired();
    return value;
  }
  async function view(
    tx: AdministrationTransaction,
    locked: Awaited<ReturnType<typeof scope>>,
    user: Principal,
  ) {
    const { p, intent, creation } = locked;
    const base = {
      operationId: p.operationId,
      checkoutId: p.checkoutId,
      orderId: creation?.orderId ?? null,
      paymentReceiptId: null,
      publicationStatus: null,
      canAbandon: false,
      reviewCode: null,
    };
    if (!creation) {
      const negative = await readPublicScreeningNegative(tx, intent.value, coordinator.key());
      if (negative) {
        await assertNoPublicScreeningEffects(tx, intent.value, locked.state);
        const closed = intent.row.status === 'closed-no-order';
        if (closed && locked.state.screeningAdmission?.status !== 'closed-no-order')
          throw screeningReconciliationRequired();
        return publicScreeningViewSchema.parse({
          ...base,
          status: closed ? 'closed-no-order' : 'source-rejected',
          canCloseNoOrder: !closed && locked.state.operatorId === user.id,
        });
      }
      if (intent.row.status === 'closed-no-order') throw screeningReconciliationRequired();
      return publicScreeningViewSchema.parse({
        ...base,
        status:
          intent.row.status === 'closed-unsent'
            ? 'closed-unsent'
            : intent.row.status === 'prepared'
              ? 'prepared'
              : 'awaiting-source',
        reviewCode:
          intent.row.status === 'awaiting-source' ? 'SCREENING_SOURCE_OUTCOME_UNKNOWN' : null,
        canCloseNoOrder:
          intent.row.status === 'awaiting-source' &&
          intent.value.expiresAt <= coordinator.clock() &&
          locked.state.operatorId === user.id,
      });
    }
    const tombstone = await abandoned(tx, p.operationId);
    if (tombstone) {
      if (
        tombstone.orderId !== creation.orderId ||
        tombstone.checkoutId !== creation.checkoutId ||
        tombstone.customerId !== creation.customerId ||
        tombstone.storeId !== creation.storeId ||
        tombstone.counterId !== creation.counterId ||
        tombstone.creationHash !== publicScreeningHash(coordinator.key(), 'creation', creation)
      )
        throw screeningReconciliationRequired();
      return publicScreeningViewSchema.parse({
        ...base,
        status: 'abandoned',
        publicationStatus: 'cancelled',
      });
    }
    await verifyPublicStructure(tx, creation, coordinator.key());
    const completion = await readPublicCompletion(tx, creation, coordinator.key());
    if (completion) {
      const publication = await readPublicPublication(tx, creation, coordinator.key());
      return publicScreeningViewSchema.parse({
        ...base,
        status: 'completed',
        paymentReceiptId: completion.paymentReceiptId,
        publicationStatus:
          publication?.status ??
          (coordinator.options.publicationContract ? 'pending' : 'unavailable'),
        reviewCode:
          publication?.status === 'uncertain' ? 'SCREENING_PUBLICATION_OUTCOME_UNKNOWN' : null,
      });
    }
    const [order] = await tx
      .select({ status: Order.order_statuses, payment: Order.payment_statuses })
      .from(Order)
      .where(eq(Order.id, BigInt(creation.orderId)))
      .limit(1)
      .for('share');
    return publicScreeningViewSchema.parse({
      ...base,
      status: 'awaiting-payment',
      canAbandon:
        user.userType === 1 &&
        [1, 2, 3].includes(user.role) &&
        order?.status === 0n &&
        order.payment === 0n,
      reviewCode: 'SCREENING_PAYMENT_RECONCILIATION_REQUIRED',
    });
  }
  async function checkedRead(user: Principal, p: PublicScreeningScope) {
    await coordinator.session(user);
    const result = await coordinator.transaction(async (tx) =>
      view(tx, await scope(tx, user, p), user),
    );
    await coordinator.session(user);
    return result;
  }
  async function closeNative(
    tx: AdministrationTransaction,
    user: Principal,
    p: PublicScreeningScope,
    requestSource: boolean,
  ): Promise<'closed-unsent' | 'closed-no-order' | null> {
    const { creation, state, intent } = await scope(tx, user, p);
    if (state.operatorId !== user.id)
      throw new AppError(
        403,
        'CHECKOUT_OWNER_REQUIRED',
        'Only the original operator can close this admission.',
      );
    if (creation || state.orderId) throw screeningReconciliationRequired();
    const negative = await readPublicScreeningNegative(tx, intent.value, coordinator.key());
    if (negative) {
      await assertNoPublicScreeningEffects(tx, intent.value, state);
      if (intent.row.status === 'closed-no-order') {
        if (state.screeningAdmission?.status !== 'closed-no-order')
          throw screeningReconciliationRequired();
        return 'closed-no-order';
      }
    } else if (intent.row.status === 'closed-no-order') throw screeningReconciliationRequired();
    if (
      !negative &&
      intent.row.status === 'closed-unsent' &&
      state.screeningAdmission?.status === 'closed-unsent'
    )
      return 'closed-unsent';
    const [operation] = await tx
      .select()
      .from(checkoutOperations)
      .where(
        and(
          eq(checkoutOperations.checkoutId, p.checkoutId),
          eq(checkoutOperations.id, p.operationId),
        ),
      )
      .limit(1)
      .for('update');
    if (
      !operation ||
      !['inflight', 'uncertain', 'rejected'].includes(operation.status) ||
      operation.result !== null
    )
      throw screeningReconciliationRequired();
    if (!negative) {
      if (intent.value.expiresAt > coordinator.clock())
        throw new AppError(
          409,
          'SCREENING_SUBMISSION_INFLIGHT',
          'Wait for the original submission before closing it.',
        );
      if (intent.row.status === 'awaiting-source' && requestSource) return null;
      if (intent.row.status !== 'prepared') throw screeningReconciliationRequired();
      const [dispatch] = await tx
        .select()
        .from(publicScreeningSubmissionDispatches)
        .where(eq(publicScreeningSubmissionDispatches.operationId, p.operationId))
        .limit(1)
        .for('share');
      if (dispatch) throw screeningReconciliationRequired();
      const [reservation] = await tx.execute(
        sql`SELECT operation_id FROM pos_rewrite_import_screening_reservations WHERE operation_id=${p.operationId} LIMIT 1`,
      );
      if (!Array.isArray(reservation) || reservation.length)
        throw screeningReconciliationRequired();
    }
    const status = negative ? ('closed-no-order' as const) : ('closed-unsent' as const);
    const next = checkoutStateSchema.parse({
      ...state,
      version: state.version + 1,
      busyOperationId: null,
      phase: 'quoted',
      screeningAdmission: { operationId: p.operationId, status },
      updatedAt: coordinator.clock(),
    });
    await tx
      .update(checkoutSessions)
      .set({ version: next.version, state: next })
      .where(eq(checkoutSessions.id, state.id));
    await tx
      .update(checkoutOperations)
      .set({
        status: 'rejected',
        errorCode: negative
          ? 'SCREENING_ADMISSION_CLOSED_NO_ORDER'
          : 'SCREENING_ADMISSION_CLOSED_UNSENT',
      })
      .where(
        and(
          eq(checkoutOperations.checkoutId, p.checkoutId),
          eq(checkoutOperations.id, p.operationId),
        ),
      );
    await tx
      .update(publicScreeningWork)
      .set({
        status,
        nextCheckAt: Number.MAX_SAFE_INTEGER,
        updatedAt: coordinator.clock(),
      })
      .where(eq(publicScreeningWork.operationId, p.operationId));
    return status;
  }
  return {
    read: checkedRead,
    async reconcile(user: Principal, p: PublicScreeningScope) {
      await coordinator.session(user);
      await coordinator.transaction(async (tx) => {
        const locked = await scope(tx, user, p),
          { creation, state, intent } = locked;
        if (state.operatorId !== user.id)
          throw new AppError(
            403,
            'CHECKOUT_OWNER_REQUIRED',
            'Only the original operator can adopt this checkout result. A manager can retain or abandon its unpaid order.',
          );
        if (!creation) return; // Never interpret absence as no dispatch/order.
        if (await abandoned(tx, p.operationId)) return;
        await verifyPublicStructure(tx, creation, coordinator.key());
        if (state.orderId === creation.orderId) return;
        const [operation] = await tx
          .select()
          .from(checkoutOperations)
          .where(
            and(
              eq(checkoutOperations.checkoutId, p.checkoutId),
              eq(checkoutOperations.id, p.operationId),
            ),
          )
          .limit(1)
          .for('update');
        if (
          !operation ||
          operation.status === 'succeeded' ||
          (operation.status === 'inflight' && intent.row.nextCheckAt > coordinator.clock())
        )
          throw new AppError(
            409,
            'SCREENING_SUBMISSION_INFLIGHT',
            'Wait for the original submission before recovering its result.',
          );
        // Fence the original callback before adopting authentic source identity.
        // No confirmation/payment/stock call is dispatched by this operation.
        const next = checkoutStateSchema.parse({
          ...state,
          version: state.version + 1,
          phase: 'order-created',
          busyOperationId: null,
          orderId: creation.orderId,
          orderSubmissionOperationId: p.operationId,
          confirmationPhase: 'not-dispatched',
          screeningAdmission: { operationId: p.operationId, status: 'created' },
          updatedAt: coordinator.clock(),
        });
        await tx
          .update(checkoutSessions)
          .set({ version: next.version, state: next })
          .where(eq(checkoutSessions.id, state.id));
        await tx
          .update(checkoutOperations)
          .set({ status: 'uncertain', errorCode: 'SCREENING_SOURCE_IDENTITY_RECOVERED' })
          .where(
            and(
              eq(checkoutOperations.checkoutId, p.checkoutId),
              eq(checkoutOperations.id, p.operationId),
            ),
          );
        await tx
          .update(publicScreeningWork)
          .set({
            status: 'awaiting-payment',
            nextCheckAt: coordinator.clock() + 30000,
            updatedAt: coordinator.clock(),
          })
          .where(eq(publicScreeningWork.operationId, p.operationId));
      });
      return checkedRead(user, p);
    },
    async closeUnsent(user: Principal, p: PublicScreeningScope) {
      await coordinator.session(user);
      let status = await coordinator.transaction((tx) => closeNative(tx, user, p, true));
      if (status === null) {
        // Explicit closure only; GET/reload never sends this request. No SQL
        // transaction/lock is held during the private source call.
        await coordinator.session(user);
        await requestPublicScreeningNegative(coordinator.options, p.operationId);
        await coordinator.session(user);
        status = await coordinator.transaction((tx) => closeNative(tx, user, p, false));
      }
      if (status === null) throw screeningReconciliationRequired();
      await coordinator.session(user);
      return { operationId: p.operationId, status };
    },
    async abandon(
      user: Principal,
      p: PublicScreeningScope,
      input: z.infer<typeof publicScreeningAbandonInputSchema>,
    ) {
      const parsed = publicScreeningAbandonInputSchema.parse(input);
      // Resolve only native checkout identity, then let the complete existing
      // abandonment proof enforce all current/no-financial-effect predicates.
      const current = await coordinator.transaction(async (tx) => {
        const locked = await scope(tx, user, p);
        if (!locked.creation) throw screeningReconciliationRequired();
        return { counterId: locked.state.counterId };
      });
      const adapter = publicScreeningAbandonment({
        config: coordinator.config,
        db: coordinator.db,
        proofKey: coordinator.key(),
        checkins: coordinator.checkins,
        authSessionValid: async (actor, transaction) => {
          await coordinator.session(actor, transaction);
          return true;
        },
        clock: coordinator.clock,
      });
      await adapter.abandon(user, {
        operationId: parsed.commandId,
        sourceOperationId: p.operationId,
        storeId: p.storeId,
        counterId: current.counterId,
        reason: parsed.reason,
      });
      // Separate journal cleanup may be lost; the immutable tombstone remains
      // authoritative and a later GET still proves the abandonment.
      await coordinator.transaction(async (tx) => {
        const locked = await scope(tx, user, p);
        const proof = await abandoned(tx, p.operationId);
        if (!proof || !locked.creation || proof.orderId !== locked.creation.orderId)
          throw screeningReconciliationRequired();
        if (locked.state.screeningAdmission?.status === 'abandoned') return;
        const state = checkoutStateSchema.parse({
          ...locked.state,
          version: locked.state.version + 1,
          busyOperationId: null,
          screeningAdmission: { operationId: p.operationId, status: 'abandoned' },
          updatedAt: coordinator.clock(),
        });
        await tx
          .update(checkoutSessions)
          .set({ version: state.version, state })
          .where(eq(checkoutSessions.id, state.id));
        await tx
          .update(checkoutOperations)
          .set({ status: 'rejected', errorCode: 'SCREENING_ORDER_ABANDONED' })
          .where(
            and(
              eq(checkoutOperations.checkoutId, p.checkoutId),
              eq(checkoutOperations.id, p.operationId),
            ),
          );
        await tx
          .update(publicScreeningWork)
          .set({
            status: 'abandoned',
            nextCheckAt: Number.MAX_SAFE_INTEGER,
            updatedAt: coordinator.clock(),
          })
          .where(eq(publicScreeningWork.operationId, p.operationId));
      });
      return checkedRead(user, p);
    },
  };
}
