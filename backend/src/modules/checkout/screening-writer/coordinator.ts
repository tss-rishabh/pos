import { eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import {
  financialTransaction,
  lockScreeningCustomer,
} from '../../legacy-order-imports/screening-transactions.js';
import { checkoutSessions } from '../schema.js';
import { checkoutStateSchema, type CheckoutState } from '../contracts.js';
import type { CheckoutEnvironment } from '../gateway.js';
import type { Payload } from '../payloads.js';
import type { PaymentAttempt, PaymentInput } from '../payments/contracts.js';
import { nodeScreeningWriterIssuer } from './issuer.js';
import { nodeScreeningWriterContract, type NodeScreeningWriterCapability } from './capability.js';
import type { PublicScreeningOptions } from './options.js';
import { publicScreeningWork, publicScreeningSubmissionDispatches } from './schema.js';
import {
  publicScreeningHash,
  readPublicScreeningCreation,
  assertPublicScreeningOrderAvailable,
  screeningReconciliationRequired,
  type PublicScreeningCreation,
} from './proof.js';
import {
  assertPublicScreeningVariant,
  screeningVerificationKey,
  lockPublicRequest,
  lockPublicCreation,
  readPublicIntent,
  publicOrderHint,
  creationForPublicOrder,
  verifyPublicStructure,
  activePublicCustomer,
} from './native.js';
import {
  validPublicScreeningSession,
  currentPublicScreeningActor,
  markPublicScreeningRequest,
} from './request-scope.js';
import {
  recordPublicPaymentIntent,
  completePublicPayment,
  completePublicPrepaid,
  readPublicCompletion,
} from './settlement.js';

export function publicScreeningCoordinator(
  config: Config,
  db: Databases,
  environment: CheckoutEnvironment,
  options: PublicScreeningOptions & {
    authSessionValid?: (
      user: Principal,
      transaction?: AdministrationTransaction,
    ) => Promise<boolean>;
    checkins?: Pick<ReturnType<typeof checkInService>, 'assertCheckIn'>;
  } = {},
) {
  const clock = options.clock ?? Date.now,
    checkins = options.checkins ?? checkInService(db, config),
    valid = options.authSessionValid ?? validPublicScreeningSession,
    selected = options.contract === nodeScreeningWriterContract,
    tracking = selected || Boolean(options.proofKey),
    contexts = new WeakMap<AdministrationTransaction, Map<string, PublicScreeningCreation>>(),
    actors = new WeakMap<AdministrationTransaction, Principal>(),
    blocked = new WeakMap<AdministrationTransaction, Map<string, unknown>>();
  const key = () => screeningVerificationKey(options.proofKey);
  async function session(user: Principal, transaction?: AdministrationTransaction) {
    markPublicScreeningRequest(user);
    if (!(await valid(user, transaction)))
      throw new AppError(
        401,
        'SESSION_EXPIRED',
        'Sign in again to continue. The original screening outcome is retained.',
      );
  }
  const transaction = <T>(work: (tx: AdministrationTransaction) => Promise<T>) =>
    financialTransaction(db, true, work);
  function remember(tx: AdministrationTransaction, creation: PublicScreeningCreation) {
    let values = contexts.get(tx);
    if (!values) {
      values = new Map();
      contexts.set(tx, values);
    }
    values.set(creation.orderId, creation);
  }
  const remembered = (tx: AdministrationTransaction, orderId: string) =>
    contexts.get(tx)?.get(orderId) ?? null;
  async function recordAdmission(
    tx: AdministrationTransaction,
    state: CheckoutState,
    value: NodeScreeningWriterCapability,
  ) {
    if (
      state.screeningAdmission?.operationId !== value.operationId ||
      state.screeningAdmission.status !== 'pending'
    )
      throw screeningReconciliationRequired();
    const [prior] = await tx
      .select({ id: publicScreeningWork.operationId })
      .from(publicScreeningWork)
      .where(eq(publicScreeningWork.operationId, value.operationId))
      .limit(1);
    if (prior)
      throw new AppError(
        409,
        'SCREENING_ADMISSION_ALREADY_REQUESTED',
        'Read the original screening operation. It cannot be issued again.',
      );
    await tx.insert(publicScreeningWork).values({
      operationId: value.operationId,
      checkoutId: value.checkoutId,
      actorId: value.actorId,
      storeId: value.storeId,
      data: value,
      proofHash: publicScreeningHash(key(), 'intent', value),
      status: 'prepared',
      createdAt: value.issuedAt,
      updatedAt: value.issuedAt,
      nextCheckAt: value.expiresAt,
    });
  }
  const issuer = nodeScreeningWriterIssuer({
    db,
    environment: { ...environment, screeningWriterContract: options.contract },
    checkins,
    authSessionValid: valid,
    clock,
    recordAdmission,
  });
  const service = {
    async issue(user: Principal, state: CheckoutState, operationId: string, payload: Payload) {
      if (!selected)
        throw new AppError(
          503,
          'SCREENING_WRITER_UNAVAILABLE',
          'Screening checkout requires the qualified shared writer.',
        );
      key();
      if (options.proofKey === environment.customerContextKey)
        throw screeningReconciliationRequired();
      assertPublicScreeningVariant(state);
      return issuer.issue(
        user,
        { storeId: state.storeId, checkoutId: state.id, operationId },
        payload,
      );
    },
    async beforeDispatch(user: Principal, state: CheckoutState, operationId: string) {
      await session(user);
      await transaction(async (tx) => {
        await lockPublicRequest(tx, user, state.storeId, state.counterId, checkins);
        await session(user, tx);
        const [saved] = await tx
          .select()
          .from(checkoutSessions)
          .where(eq(checkoutSessions.id, state.id))
          .limit(1)
          .for('update');
        const current = checkoutStateSchema.parse(saved?.state),
          intent = await readPublicIntent(tx, operationId, key());
        if (
          !intent ||
          current.operatorId !== user.id ||
          current.storeId !== state.storeId ||
          current.counterId !== state.counterId ||
          current.busyOperationId !== operationId ||
          current.phase !== 'quoted' ||
          current.screeningAdmission?.operationId !== operationId ||
          intent.row.status !== 'prepared' ||
          intent.value.expiresAt <= clock()
        )
          throw screeningReconciliationRequired();
        const [prior] = await tx
          .select()
          .from(publicScreeningSubmissionDispatches)
          .where(eq(publicScreeningSubmissionDispatches.operationId, operationId))
          .limit(1);
        if (prior) throw screeningReconciliationRequired();
        const proof = {
          contract: 'pos-node-screening-submission-dispatch-v1',
          operationId,
          requestHash: intent.value.requestHash,
          dispatchedAt: clock(),
        };
        await tx.insert(publicScreeningSubmissionDispatches).values({
          operationId,
          data: proof,
          proofHash: publicScreeningHash(key(), 'submission-dispatch', proof),
        });
        await tx
          .update(publicScreeningWork)
          .set({ status: 'awaiting-source', updatedAt: clock(), nextCheckAt: clock() + 15000 })
          .where(eq(publicScreeningWork.operationId, operationId));
      });
      await session(user);
    },
    async created(user: Principal, state: CheckoutState, operationId: string, orderId: string) {
      await session(user);
      await transaction(async (tx) => {
        await lockPublicRequest(tx, user, state.storeId, state.counterId, checkins);
        await session(user, tx);
        const creation = await readPublicScreeningCreation(tx, operationId, key());
        if (
          !creation ||
          creation.orderId !== orderId ||
          creation.checkoutId !== state.id ||
          creation.actorId !== user.id
        )
          throw screeningReconciliationRequired();
        const locked = await lockPublicCreation(tx, creation, key());
        await verifyPublicStructure(tx, creation, key());
        if (locked.intent.row.status === 'awaiting-source')
          await tx
            .update(publicScreeningWork)
            .set({ status: 'awaiting-payment', updatedAt: clock(), nextCheckAt: clock() + 30000 })
            .where(eq(publicScreeningWork.operationId, operationId));
      });
      await session(user);
    },
  };
  const payments = {
    requiresCurrentReads: tracking,
    transaction,
    async lockOrder(
      tx: AdministrationTransaction,
      user: Principal,
      storeId: string,
      orderId: string,
      purpose: 'authority' | 'evidence',
    ) {
      const hint = await publicOrderHint(tx, storeId, orderId);
      if (!hint) return;
      await session(user, tx);
      actors.set(tx, user);
      // Current Store/check-in are already held by the ordinary repository.
      // The current nonlocking hint is rechecked only after checkout/customer/Order.
      try {
        const creation = await creationForPublicOrder(tx, orderId, key());
        if (creation.storeId !== storeId || creation.customerId !== hint.customerId)
          throw screeningReconciliationRequired();
        await lockPublicCreation(tx, creation, key());
        await verifyPublicStructure(tx, creation, key());
        remember(tx, creation);
        if (purpose === 'authority') await assertPublicScreeningOrderAvailable(tx, orderId);
      } catch (error) {
        if (purpose !== 'evidence') throw error;
        // Preserve an already received provider decision even when the public
        // contract/evidence becomes unavailable. This never permits settlement.
        await lockScreeningCustomer(tx, hint.customerId);
        let values = blocked.get(tx);
        if (!values) {
          values = new Map();
          blocked.set(tx, values);
        }
        values.set(orderId, error);
      }
      await session(user, tx);
    },
    async available(tx: AdministrationTransaction, orderId: string) {
      const failure = blocked.get(tx)?.get(orderId);
      if (failure)
        throw new AppError(
          409,
          'SCREENING_PAYMENT_HELD_AFTER_DISPATCH',
          'The payment response is retained for screening reconciliation.',
        );
      const creation = remembered(tx, orderId);
      if (!creation) return;
      await assertPublicScreeningOrderAvailable(tx, orderId);
      await activePublicCustomer(tx, creation);
    },
    async intent(
      tx: AdministrationTransaction,
      attempt: PaymentAttempt,
      input: PaymentInput,
      hashSecret: string,
    ) {
      const creation = remembered(tx, attempt.orderId);
      if (creation) {
        const user = actors.get(tx);
        if (!user) throw screeningReconciliationRequired();
        await session(user, tx);
        await recordPublicPaymentIntent(tx, creation, attempt, input, key(), hashSecret);
        await session(user, tx);
      }
    },
    async paid(tx: AdministrationTransaction, attempt: PaymentAttempt, hashSecret: string) {
      const creation = remembered(tx, attempt.orderId);
      if (creation) {
        const user = actors.get(tx);
        if (!user) throw screeningReconciliationRequired();
        await session(user, tx);
        await completePublicPayment(tx, creation, attempt, key(), hashSecret, clock);
        await session(user, tx);
      }
    },
    async readPaid(tx: AdministrationTransaction, attempt: PaymentAttempt) {
      const creation = remembered(tx, attempt.orderId);
      if (creation && !(await readPublicCompletion(tx, creation, key())))
        throw screeningReconciliationRequired();
    },
  };
  const finalization = {
    async transaction<T>(
      state: Pick<CheckoutState, 'storeId' | 'counterId'> &
        Partial<Pick<CheckoutState, 'screeningAdmission' | 'operatorId'>>,
      orderId: string,
      work: (tx: AdministrationTransaction) => Promise<T>,
    ): Promise<T> {
      const user = currentPublicScreeningActor();
      const admission = state.screeningAdmission;
      if (!user || user.id !== state.operatorId || !admission)
        throw screeningReconciliationRequired();
      await session(user);
      const result = await transaction(async (tx) => {
        await lockPublicRequest(tx, user, state.storeId, state.counterId, checkins);
        await session(user, tx);
        const creation = await readPublicScreeningCreation(tx, admission.operationId, key());
        if (
          !creation ||
          creation.orderId !== orderId ||
          creation.storeId !== state.storeId ||
          creation.counterId !== state.counterId
        )
          throw screeningReconciliationRequired();
        await lockPublicCreation(tx, creation, key());
        await verifyPublicStructure(tx, creation, key());
        remember(tx, creation);
        const value = await work(tx);
        await session(user, tx);
        return value;
      });
      await session(user);
      return result;
    },
    async finish(tx: AdministrationTransaction, orderId: string) {
      const creation = remembered(tx, orderId);
      if (!creation) return;
      if (creation.method === 3) await completePublicPrepaid(tx, creation, key(), clock);
    },
    async read(tx: AdministrationTransaction, orderId: string) {
      const creation = remembered(tx, orderId);
      if (!creation) return null;
      return readPublicCompletion(tx, creation, key());
    },
  };
  return {
    service,
    payments,
    finalization,
    transaction,
    clock,
    tracking,
    key,
    options,
    db,
    config,
    checkins,
    session,
    remember,
    remembered,
  };
}
export type PublicScreeningCoordinator = ReturnType<typeof publicScreeningCoordinator>;
