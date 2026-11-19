import { and, asc, eq, gt } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { HasProduct, Order, Product } from '../../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import type { CustomerOtpOperationView, CustomerOtpView } from '../../customer-otp/index.js';
import { readCustomerContactBinding, sameCustomerContact } from '../customer-contact-authority.js';
import type { CustomerVerificationClient } from '../customer-verification.js';
import {
  publicReturnVerification as view,
  returnCustomerOtpScope,
  type ReturnVerification,
} from './verification-state.js';
import { fingerprint, type ReturnState } from './state.js';
import type { ReturnVerificationOptions } from './verification.js';

/**
 * Customer verification for a return (rewrite gate; see NEEDS USER DECISION in the W4 report).
 * The proof lives in Redis `pos:return_verification:{id}`; the purpose-bound OTP itself is the
 * customer-otp module's.
 */
export function localReturnVerificationService(
  db: Databases,
  config: Config,
  options: ReturnVerificationOptions & {
    customerOtp: CustomerVerificationClient;
    state: ReturnState;
  },
) {
  const client = options.customerOtp,
    state = options.state,
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
  const notFound = () =>
    new AppError(404, 'RETURN_VERIFICATION_NOT_FOUND', 'Return verification was not found.');
  async function own(tx: AdministrationTransaction, user: Principal, storeId: string, id: string) {
    requireStore(user, storeId);
    const initial = await state.readVerification(id);
    if (!initial || initial.operatorId !== user.id || initial.storeId !== storeId) throw notFound();
    await checkIn(user.id, storeId, initial.counterId, tx);
    const contact = await readCustomerContactBinding(tx, initial.customerId);
    return sameCustomerContact(initial.contact, contact)
      ? initial
      : { ...initial, sent: false, verifiedUntil: null, deliveryStatus: 'rejected' as const };
  }
  /** Read-modify-write of the proof under its Redis lock. */
  function mutate(
    user: Principal,
    storeId: string,
    id: string,
    update: (
      tx: AdministrationTransaction,
      current: ReturnVerification,
    ) => Promise<ReturnVerification | null>,
  ) {
    return state.withVerification(id, async () => {
      const next = await db.get('writer').transaction(async (tx) => {
        const current = await own(tx, user, storeId, id);
        return (await update(tx, current)) ?? current;
      });
      await state.saveVerification(next, now());
      return next;
    });
  }
  function applyView(current: ReturnVerification, value: CustomerOtpView) {
    if (value.id !== current.otpChallengeId || !sameCustomerContact(current.contact, value.contact))
      throw changed();
    return {
      ...current,
      sent: value.status === 'sent',
      deliveryStatus: value.status,
      expiresAt: value.expiresAt,
    };
  }
  async function load(user: Principal, storeId: string, id: string) {
    const current = await db.get('writer').transaction((tx) => own(tx, user, storeId, id));
    if (!current.otpChallengeId) throw changed();
    try {
      const value = await client.read(
        user,
        returnCustomerOtpScope(current),
        current.otpChallengeId,
      );
      return {
        ...applyView(current, value),
        verifiedUntil:
          current.verifiedUntil && value.verifiedUntil === current.verifiedUntil
            ? current.verifiedUntil
            : null,
      };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return {
        ...current,
        sent: false,
        verifiedUntil: null,
        deliveryStatus: error.status === 404 ? current.deliveryStatus : ('rejected' as const),
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
    return mutate(user, storeId, id, async (tx, current) => {
      const kind =
        current.requestOperationId === operationId
          ? 'request'
          : current.verifyOperationId === operationId
            ? 'verify'
            : null;
      if (!kind || kind !== evidence.kind || !evidence.result) throw changed();
      if (current.busyOperationId !== operationId) {
        if (current.busyOperationId) throw changed();
        return null;
      }
      const contact = await readCustomerContactBinding(tx, current.customerId);
      if (
        !sameCustomerContact(current.contact, contact) ||
        !sameCustomerContact(evidence.result.contact, contact)
      )
        throw changed();
      const verified =
        kind === 'verify' &&
        !evidence.error &&
        evidence.result.verifiedUntil &&
        evidence.result.verifiedUntil > now();
      return {
        ...applyView(current, evidence.result),
        busyOperationId: null,
        verificationError:
          evidence.error || (kind === 'verify' && !verified ? 'CUSTOMER_OTP_EXPIRED' : null),
        ...(kind === 'verify'
          ? { verifiedUntil: verified ? evidence.result.verifiedUntil : null }
          : {}),
      };
    });
  }
  async function reconcile(user: Principal, storeId: string, id: string, operationId: string) {
    const current = await db.get('writer').transaction((tx) => own(tx, user, storeId, id));
    if (
      !current.otpChallengeId ||
      ![current.requestOperationId, current.verifyOperationId].includes(operationId)
    )
      throw changed();
    let evidence: CustomerOtpOperationView | null;
    try {
      evidence = await client.readOperation(
        user,
        returnCustomerOtpScope(current),
        current.otpChallengeId,
        operationId,
      );
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        !['CUSTOMER_OTP_SCOPE_CHANGED', 'CHECKOUT_CUSTOMER_UNAVAILABLE'].includes(error.code)
      )
        throw error;
      return view(
        await mutate(user, storeId, id, async (_tx, latest) => {
          if (latest.busyOperationId !== operationId) throw changed();
          return {
            ...latest,
            busyOperationId: null,
            sent: false,
            verifiedUntil: null,
            deliveryStatus: 'rejected',
            verificationError: 'CUSTOMER_OTP_SCOPE_CHANGED',
          };
        }),
      );
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
      const reservation = await state.withVerification(id, async () => {
        const hash = fingerprint('return.verification', {
          storeId,
          orderId,
          counterId,
          userId: user.id,
        });
        const existing = await state.readVerification(id);
        if (existing) {
          if (existing.requestHash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This verification key was used for another request.',
            );
          return { proof: existing, replay: true };
        }
        const proof = await db.get('writer').transaction(async (tx) => {
          requireStore(user, storeId);
          await checkIn(user.id, storeId, counterId, tx);
          const [order] = await tx
            .select({ customerId: Order.user })
            .from(Order)
            .where(eq(Order.id, BigInt(orderId)))
            .limit(1);
          if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found.');
          const customerId = String(order.customerId),
            contact = await readCustomerContactBinding(tx, customerId);
          const value: ReturnVerification = {
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
          return value;
        });
        if (!(await state.createVerification(proof, now())))
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This verification key was used for another request.',
          );
        return { proof, replay: false };
      });
      if (reservation.replay) return view(await load(user, storeId, id));
      const current = reservation.proof;
      try {
        const result = await client.request(
          user,
          returnCustomerOtpScope(current),
          current.otpChallengeId!,
          id,
          current.contact!,
        );
        return view(
          await applyEvidence(user, storeId, id, id, { kind: 'request', result, error: null }),
        );
      } catch (error) {
        if (error instanceof AppError)
          await mutate(user, storeId, id, async (_tx, latest) =>
            latest.busyOperationId === id
              ? {
                  ...latest,
                  busyOperationId: null,
                  deliveryStatus: 'rejected',
                  verificationError: 'CUSTOMER_OTP_UNAVAILABLE',
                }
              : null,
          ).catch(() => undefined);
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
      const reservation = await mutate(user, storeId, id, async (_tx, current) => {
        if (current.busyOperationId)
          throw new AppError(
            409,
            'RETURN_VERIFICATION_INFLIGHT',
            'Check the original verification action before continuing.',
          );
        if (!current.otpChallengeId || !current.requestOperationId || current.expiresAt <= now())
          throw new AppError(
            403,
            'RETURN_OTP_EXPIRED',
            'Request a new customer verification code.',
          );
        return {
          ...current,
          verifyOperationId: operationId,
          busyOperationId: operationId,
          verificationError: null,
        };
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
          await mutate(user, storeId, id, async (_tx, current) =>
            current.busyOperationId === operationId
              ? { ...current, busyOperationId: null, verificationError: 'CUSTOMER_OTP_UNAVAILABLE' }
              : null,
          ).catch(() => undefined);
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
            productType: Product.prod_type,
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
            productType: row.productType === null ? null : Number(row.productType),
            quantity: String(row.quantity),
          })),
          nextCursor: rows.length > 100 ? String(rows[99]!.id) : null,
        };
      });
    },
  };
}
