import { and, asc, eq, gt } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { HasProduct, Order, Product } from '../../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import type { CustomerOtpOperationView, CustomerOtpView } from '../../customer-otp/index.js';
import { readCustomerContactBinding, sameCustomerContact } from '../customer-contact-authority.js';
import { operationHash } from '../crypto.js';
import type { CustomerVerificationClient } from '../customer-verification.js';
import { returnVerifications, type ReturnVerification } from './schema.js';
import {
  publicReturnVerification as view,
  returnCustomerOtpScope,
  returnVerificationSchema,
} from './verification-state.js';
import type { ReturnVerificationOptions } from './verification.js';

export function localReturnVerificationService(
  db: Databases,
  config: Config,
  options: ReturnVerificationOptions & { customerOtp: CustomerVerificationClient },
) {
  const client = options.customerOtp,
    now = options.now || Date.now,
    checkIns = checkInService(db, config),
    checkIn =
      options.assertCheckIn ||
      ((user, store, counter, tx) => checkIns.assertCheckIn(user, store, counter, tx));
  const changed = () =>
    new AppError(
      409,
      'RETURN_VERIFICATION_CHANGED',
      'This verification changed. Reload before continuing.',
    );
  async function own(tx: AdministrationTransaction, user: Principal, storeId: string, id: string) {
    requireStore(user, storeId);
    const [first] = await tx
      .select({ state: returnVerifications.state })
      .from(returnVerifications)
      .where(eq(returnVerifications.id, id))
      .limit(1);
    const initial = first ? returnVerificationSchema.parse(first.state) : null;
    if (!initial || initial.operatorId !== user.id || initial.storeId !== storeId)
      throw new AppError(
        404,
        'RETURN_VERIFICATION_NOT_FOUND',
        'Return verification was not found.',
      );
    await checkIn(user.id, storeId, initial.counterId, tx);
    const [row] = await tx
      .select({ state: returnVerifications.state })
      .from(returnVerifications)
      .where(eq(returnVerifications.id, id))
      .for('update');
    if (!row) throw changed();
    const state = returnVerificationSchema.parse(row.state),
      contact = await readCustomerContactBinding(tx, state.customerId);
    return sameCustomerContact(state.contact, contact)
      ? state
      : { ...state, sent: false, verifiedUntil: null, deliveryStatus: 'rejected' as const };
  }
  function applyView(state: ReturnVerification, value: CustomerOtpView) {
    if (value.id !== state.otpChallengeId || !sameCustomerContact(state.contact, value.contact))
      throw changed();
    return {
      ...state,
      sent: value.status === 'sent',
      deliveryStatus: value.status,
      expiresAt: value.expiresAt,
    };
  }
  async function load(user: Principal, storeId: string, id: string) {
    const state = await db.get('writer').transaction((tx) => own(tx, user, storeId, id));
    if (!state.otpChallengeId) throw changed();
    try {
      const value = await client.read(user, returnCustomerOtpScope(state), state.otpChallengeId);
      return {
        ...applyView(state, value),
        verifiedUntil:
          state.verifiedUntil && value.verifiedUntil === state.verifiedUntil
            ? state.verifiedUntil
            : null,
      };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return {
        ...state,
        sent: false,
        verifiedUntil: null,
        deliveryStatus: error.status === 404 ? state.deliveryStatus : ('rejected' as const),
      };
    }
  }
  async function applyEvidence(
    user: Principal,
    storeId: string,
    id: string,
    operationId: string,
    evidence: CustomerOtpOperationView,
  ) {
    return db.get('writer').transaction(async (tx) => {
      const state = await own(tx, user, storeId, id);
      const kind =
        state.requestOperationId === operationId
          ? 'request'
          : state.verifyOperationId === operationId
            ? 'verify'
            : null;
      if (!kind || kind !== evidence.kind || !evidence.result) throw changed();
      if (state.busyOperationId !== operationId) {
        if (state.busyOperationId) throw changed();
        return state;
      }
      const contact = await readCustomerContactBinding(tx, state.customerId);
      if (
        !sameCustomerContact(state.contact, contact) ||
        !sameCustomerContact(evidence.result.contact, contact)
      )
        throw changed();
      const verified =
        kind === 'verify' &&
        !evidence.error &&
        evidence.result.verifiedUntil &&
        evidence.result.verifiedUntil > now();
      const next: ReturnVerification = {
        ...applyView(state, evidence.result),
        busyOperationId: null,
        verificationError:
          evidence.error || (kind === 'verify' && !verified ? 'CUSTOMER_OTP_EXPIRED' : null),
        ...(kind === 'verify'
          ? { verifiedUntil: verified ? evidence.result.verifiedUntil : null }
          : {}),
      };
      await tx
        .update(returnVerifications)
        .set({ state: next })
        .where(eq(returnVerifications.id, id));
      return next;
    });
  }
  async function reconcile(user: Principal, storeId: string, id: string, operationId: string) {
    const state = await db.get('writer').transaction((tx) => own(tx, user, storeId, id));
    if (
      !state.otpChallengeId ||
      ![state.requestOperationId, state.verifyOperationId].includes(operationId)
    )
      throw changed();
    let evidence: CustomerOtpOperationView | null;
    try {
      evidence = await client.readOperation(
        user,
        returnCustomerOtpScope(state),
        state.otpChallengeId,
        operationId,
      );
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        !['CUSTOMER_OTP_SCOPE_CHANGED', 'CHECKOUT_CUSTOMER_UNAVAILABLE'].includes(error.code)
      )
        throw error;
      return db.get('writer').transaction(async (tx) => {
        const latest = await own(tx, user, storeId, id);
        if (latest.busyOperationId !== operationId) throw changed();
        const next: ReturnVerification = {
          ...latest,
          busyOperationId: null,
          sent: false,
          verifiedUntil: null,
          deliveryStatus: 'rejected',
          verificationError: 'CUSTOMER_OTP_SCOPE_CHANGED',
        };
        await tx
          .update(returnVerifications)
          .set({ state: next })
          .where(eq(returnVerifications.id, id));
        return view(next);
      });
    }
    if (!evidence)
      throw new AppError(
        409,
        'RETURN_VERIFICATION_OUTCOME_UNPROVED',
        'The original verification outcome is unproved. Keep this reference and check its status.',
      );
    return view(await applyEvidence(user, storeId, id, operationId, evidence));
  }
  return {
    async create(user: Principal, storeId: string, orderId: string, id: string, counterId: string) {
      const reservation = await db.get('writer').transaction(async (tx) => {
        requireStore(user, storeId);
        await checkIn(user.id, storeId, counterId, tx);
        const [order] = await tx
          .select({ customerId: Order.user })
          .from(Order)
          .where(eq(Order.id, BigInt(orderId)))
          .limit(1)
          .for('update');
        if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found.');
        const hash = operationHash(
            'return.verification',
            { storeId, orderId, counterId, userId: user.id },
            options.secret,
          ),
          [existing] = await tx
            .select({ state: returnVerifications.state })
            .from(returnVerifications)
            .where(eq(returnVerifications.id, id))
            .for('update');
        if (existing) {
          const proof = returnVerificationSchema.parse(existing.state);
          if (proof.requestHash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This verification key was used for another request.',
            );
          return { proof, replay: true };
        }
        const customerId = String(order.customerId),
          contact = await readCustomerContactBinding(tx, customerId);
        const proof: ReturnVerification = {
          id,
          operatorId: user.id,
          storeId,
          counterId,
          orderId,
          customerId,
          requestHash: hash,
          sent: false,
          expiresAt: now() + 300000,
          verifiedUntil: null,
          busyOperationId: id,
          contact,
          otpChallengeId: crypto.randomUUID(),
          deliveryStatus: 'pending',
          requestOperationId: id,
          verifyOperationId: null,
          verificationError: null,
        };
        await tx.insert(returnVerifications).values({ id, state: proof });
        return { proof, replay: false };
      });
      if (reservation.replay) return view(await load(user, storeId, id));
      const state = reservation.proof;
      try {
        const result = await client.request(
          user,
          returnCustomerOtpScope(state),
          state.otpChallengeId!,
          id,
          state.contact!,
        );
        return view(
          await applyEvidence(user, storeId, id, id, { kind: 'request', result, error: null }),
        );
      } catch (error) {
        if (error instanceof AppError)
          await db.get('writer').transaction(async (tx) => {
            const latest = await own(tx, user, storeId, id);
            if (latest.busyOperationId === id)
              await tx
                .update(returnVerifications)
                .set({
                  state: {
                    ...latest,
                    busyOperationId: null,
                    deliveryStatus: 'rejected',
                    verificationError: 'CUSTOMER_OTP_UNAVAILABLE',
                  },
                })
                .where(eq(returnVerifications.id, id));
          });
        throw error instanceof AppError
          ? error
          : new AppError(
              503,
              'RETURN_OTP_DELIVERY_UNCONFIRMED',
              'Verification was interrupted. Check its original action before requesting another code.',
            );
      }
    },
    async read(user: Principal, storeId: string, id: string) {
      return view(await load(user, storeId, id));
    },
    reconcile,
    async verify(user: Principal, storeId: string, id: string, operationId: string, code: string) {
      const reservation = await db.get('writer').transaction(async (tx) => {
        const state = await own(tx, user, storeId, id);
        if (state.busyOperationId)
          throw new AppError(
            409,
            'RETURN_VERIFICATION_INFLIGHT',
            'Check the original verification action before continuing.',
          );
        if (!state.otpChallengeId || !state.requestOperationId || state.expiresAt <= now())
          throw new AppError(
            403,
            'RETURN_OTP_EXPIRED',
            'Request a new customer verification code.',
          );
        const next = {
          ...state,
          verifyOperationId: operationId,
          busyOperationId: operationId,
          verificationError: null,
        };
        await tx
          .update(returnVerifications)
          .set({ state: next })
          .where(eq(returnVerifications.id, id));
        return next;
      });
      try {
        const result = await client.verify(
          user,
          returnCustomerOtpScope(reservation),
          reservation.otpChallengeId!,
          operationId,
          code,
        );
        return view(
          await applyEvidence(user, storeId, id, operationId, {
            kind: 'verify',
            result,
            error: null,
          }),
        );
      } catch (error) {
        if (
          error instanceof AppError &&
          ['CUSTOMER_OTP_INVALID', 'CUSTOMER_OTP_ATTEMPT_LIMIT'].includes(error.code)
        ) {
          await reconcile(user, storeId, id, operationId);
        } else if (error instanceof AppError) {
          await db.get('writer').transaction(async (tx) => {
            const state = await own(tx, user, storeId, id);
            if (state.busyOperationId === operationId)
              await tx
                .update(returnVerifications)
                .set({
                  state: {
                    ...state,
                    busyOperationId: null,
                    verificationError: 'CUSTOMER_OTP_UNAVAILABLE',
                  },
                })
                .where(eq(returnVerifications.id, id));
          });
        }
        // Unknown outcomes retain the original busy reference; reconciliation
        // reads the OTP receipt and never repeats verification or delivery.
        throw error instanceof AppError
          ? error
          : new AppError(
              503,
              'RETURN_OTP_VERIFICATION_UNCONFIRMED',
              'Verification was interrupted. Check its original action before continuing.',
            );
      }
    },
    async lines(user: Principal, storeId: string, id: string, after = '0') {
      const current = await load(user, storeId, id);
      if (!current.verifiedUntil || current.verifiedUntil <= now())
        throw new AppError(
          403,
          'RETURN_CUSTOMER_VERIFICATION_REQUIRED',
          'Verify the order customer before viewing returnable lines.',
        );
      return db.get('writer').transaction(async (tx) => {
        const proof = await own(tx, user, storeId, id);
        if (proof.verifiedUntil !== current.verifiedUntil) throw changed();
        if (
          !client.assertVerified ||
          !proof.otpChallengeId ||
          !proof.contact ||
          !proof.verifiedUntil
        )
          throw new AppError(
            503,
            'CUSTOMER_OTP_UNAVAILABLE',
            'The customer verification proof could not be checked.',
          );
        await client.assertVerified(
          tx,
          user,
          returnCustomerOtpScope(proof),
          proof.otpChallengeId,
          proof.contact,
          proof.verifiedUntil,
        );
        const rows = await tx
          .select({
            id: HasProduct.id,
            productId: HasProduct.product,
            name: Product.product,
            parentId: Product.parent_prod_id,
            quantity: HasProduct.qty,
            status: HasProduct.status,
            returnStatus: HasProduct.return_status,
          })
          .from(HasProduct)
          .leftJoin(Product, eq(Product.id, HasProduct.product))
          .where(and(eq(HasProduct.order, BigInt(proof.orderId)), gt(HasProduct.id, BigInt(after))))
          .orderBy(asc(HasProduct.id))
          .limit(101);
        return {
          data: rows.slice(0, 100).map((row) => ({
            ...row,
            id: String(row.id),
            productId: String(row.productId),
            parentId: String(row.parentId || 0),
            quantity: String(row.quantity),
          })),
          nextCursor: rows.length > 100 ? String(rows[99]!.id) : null,
        };
      });
    },
  };
}
