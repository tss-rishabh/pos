import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { HasProduct, Order, Product } from '../../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import type { CheckoutRepository } from '../contracts.js';
import { readCustomerContactBinding, sameCustomerContact } from '../customer-contact-authority.js';
import { operationHash } from '../crypto.js';
import type { CustomerVerificationClient } from '../customer-verification.js';
import { localReturnVerificationService } from './local-verification.js';
import {
  returnVerificationSchema,
  publicReturnVerification as view,
} from './verification-state.js';
export { returnVerificationSchema } from './verification-state.js';
import type { ReturnGateway } from './contracts.js';
import {
  returnVerifications,
  returnVerificationLimits,
  type ReturnVerification,
} from './schema.js';
export interface ReturnVerificationOptions {
  secret: string;
  customerOtp?: CustomerVerificationClient;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string,
    transaction: AdministrationTransaction,
  ) => Promise<void>;
  now?: () => number;
}
export function returnVerificationService(
  db: Databases,
  config: Config,
  customers: CheckoutRepository,
  gateway: ReturnGateway,
  options: ReturnVerificationOptions,
) {
  if (options.customerOtp)
    return localReturnVerificationService(db, config, {
      ...options,
      customerOtp: options.customerOtp,
    });
  const checkIns = checkInService(db, config),
    checkIn =
      options.assertCheckIn ||
      ((user, store, counter, tx) => checkIns.assertCheckIn(user, store, counter, tx)),
    now = options.now || Date.now;
  async function own(tx: AdministrationTransaction, user: Principal, storeId: string, id: string) {
    requireStore(user, storeId);
    const [row] = await tx
      .select({ state: returnVerifications.state })
      .from(returnVerifications)
      .where(eq(returnVerifications.id, id))
      .limit(1);
    const proof = row ? returnVerificationSchema.parse(row.state) : null;
    if (!proof || proof.operatorId !== user.id || proof.storeId !== storeId)
      throw new AppError(
        404,
        'RETURN_VERIFICATION_NOT_FOUND',
        'Return verification was not found.',
      );
    await checkIn(user.id, storeId, proof.counterId, tx);
    const [locked] = await tx
      .select({ state: returnVerifications.state })
      .from(returnVerifications)
      .where(eq(returnVerifications.id, id))
      .for('update');
    if (!locked)
      throw new AppError(
        404,
        'RETURN_VERIFICATION_NOT_FOUND',
        'Return verification was not found.',
      );
    const current = returnVerificationSchema.parse(locked.state),
      contact = await readCustomerContactBinding(tx, current.customerId);
    return sameCustomerContact(current.contact, contact)
      ? current
      : { ...current, sent: false, verifiedUntil: null };
  }
  return {
    async reconcile(_user: Principal, _storeId: string, _id: string, _operationId: string) {
      throw new AppError(
        503,
        'CUSTOMER_OTP_UNAVAILABLE',
        'Customer verification recovery requires the local purpose-bound service.',
      );
    },
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
          const contact = await readCustomerContactBinding(tx, proof.customerId);
          return {
            proof: sameCustomerContact(proof.contact, contact)
              ? proof
              : { ...proof, sent: false, verifiedUntil: null },
            replay: true,
          };
        }
        const customerId = String(order.customerId),
          customer = await customers.customer(customerId, 'writer'),
          contact = await readCustomerContactBinding(tx, customerId);
        if (!customer?.active)
          throw new AppError(
            409,
            'RETURN_CUSTOMER_UNAVAILABLE',
            'The order customer could not be confirmed.',
          );
        await tx
          .insert(returnVerificationLimits)
          .values({
            customerId,
            state: { nextSendAt: 0, attempts: 0, resetAt: now() + 5 * 60000 },
            updatedAt: now(),
          })
          .onDuplicateKeyUpdate({
            set: { customerId: sql`${returnVerificationLimits.customerId}` },
          });
        const [limit] = await tx
          .select()
          .from(returnVerificationLimits)
          .where(eq(returnVerificationLimits.customerId, customerId))
          .for('update');
        if (!limit)
          throw new AppError(
            503,
            'RETURN_VERIFICATION_UNAVAILABLE',
            'Customer verification is unavailable.',
          );
        if (limit.state.nextSendAt > now())
          throw new AppError(
            429,
            'RETURN_OTP_SEND_LIMIT',
            'Wait before requesting another customer verification code.',
          );
        const state =
          limit.state.resetAt <= now()
            ? { nextSendAt: now() + 60000, attempts: 0, resetAt: now() + 5 * 60000 }
            : { ...limit.state, nextSendAt: now() + 60000 };
        await tx
          .update(returnVerificationLimits)
          .set({ state, updatedAt: now() })
          .where(eq(returnVerificationLimits.customerId, customerId));
        const proof: ReturnVerification = {
          id,
          operatorId: user.id,
          storeId,
          counterId,
          orderId,
          customerId,
          requestHash: hash,
          sent: false,
          expiresAt: now() + 5 * 60000,
          verifiedUntil: null,
          busyOperationId: id,
          contact,
          otpChallengeId: crypto.randomUUID(),
        };
        await tx.insert(returnVerifications).values({ id, state: proof });
        return { proof, replay: false };
      });
      if (reservation.replay) return view(reservation.proof);
      try {
        await gateway.sendOtp(reservation.proof.customerId);
      } catch {
        await db
          .get('writer')
          .update(returnVerifications)
          .set({ state: { ...reservation.proof, busyOperationId: null } })
          .where(eq(returnVerifications.id, id));
        throw new AppError(
          502,
          'RETURN_OTP_DELIVERY_UNCONFIRMED',
          'Verification delivery was not confirmed. Wait before requesting a new code.',
        );
      }
      const proof = await db.get('writer').transaction(async (tx) => {
        const latest = await own(tx, user, storeId, id);
        if (latest.busyOperationId !== id)
          throw new AppError(
            409,
            'RETURN_VERIFICATION_CHANGED',
            'This verification changed. Reload before continuing.',
          );
        const current = await readCustomerContactBinding(tx, latest.customerId);
        const next = {
          ...latest,
          sent: sameCustomerContact(reservation.proof.contact, current),
          busyOperationId: null,
        };
        await tx
          .update(returnVerifications)
          .set({ state: next })
          .where(eq(returnVerifications.id, id));
        return next;
      });
      if (!proof.sent)
        throw new AppError(
          409,
          'CUSTOMER_CONTACT_CHANGED',
          'Customer contact changed. Request a new verification code.',
        );
      return view(proof);
    },
    async read(user: Principal, storeId: string, id: string) {
      return db.get('writer').transaction(async (tx) => view(await own(tx, user, storeId, id)));
    },
    async lines(user: Principal, storeId: string, id: string, after = '0') {
      return db.get('writer').transaction(async (tx) => {
        const proof = await own(tx, user, storeId, id);
        if (!proof.verifiedUntil || proof.verifiedUntil <= now())
          throw new AppError(
            403,
            'RETURN_CUSTOMER_VERIFICATION_REQUIRED',
            'Verify the order customer before viewing returnable lines.',
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
    async verify(user: Principal, storeId: string, id: string, operationId: string, otp: string) {
      const reservation = await db.get('writer').transaction(async (tx) => {
        const proof = await own(tx, user, storeId, id);
        if (proof.verifiedUntil && proof.verifiedUntil > now()) return { proof, replay: true };
        if (proof.busyOperationId)
          throw new AppError(
            409,
            'RETURN_VERIFICATION_INFLIGHT',
            'This verification is already being confirmed.',
          );
        if (!proof.sent || proof.expiresAt <= now())
          throw new AppError(
            403,
            'RETURN_OTP_EXPIRED',
            'Request a new customer verification code.',
          );
        const [limit] = await tx
          .select()
          .from(returnVerificationLimits)
          .where(eq(returnVerificationLimits.customerId, proof.customerId))
          .for('update');
        if (!limit || limit.state.attempts >= 5)
          throw new AppError(
            429,
            'RETURN_OTP_ATTEMPT_LIMIT',
            'Too many verification attempts. Wait before requesting another code.',
          );
        await tx
          .update(returnVerificationLimits)
          .set({ state: { ...limit.state, attempts: limit.state.attempts + 1 }, updatedAt: now() })
          .where(eq(returnVerificationLimits.customerId, proof.customerId));
        const next = { ...proof, busyOperationId: operationId };
        await tx
          .update(returnVerifications)
          .set({ state: next })
          .where(eq(returnVerifications.id, id));
        return { proof: next, replay: false };
      });
      if (reservation.replay) return view(reservation.proof);
      let valid = false;
      try {
        valid = await gateway.verifyOtp(reservation.proof.customerId, otp);
      } catch {
        await db
          .get('writer')
          .update(returnVerifications)
          .set({ state: { ...reservation.proof, sent: false, busyOperationId: null } })
          .where(eq(returnVerifications.id, id));
        throw new AppError(
          502,
          'RETURN_OTP_VERIFICATION_UNCONFIRMED',
          'Customer verification was not confirmed. Request a new code.',
        );
      }
      let contactChanged = false;
      const proof = await db.get('writer').transaction(async (tx) => {
        const latest = await own(tx, user, storeId, id);
        if (latest.busyOperationId !== operationId)
          throw new AppError(
            409,
            'RETURN_VERIFICATION_CHANGED',
            'This verification changed. Reload before continuing.',
          );
        const current = await readCustomerContactBinding(tx, latest.customerId);
        contactChanged = !sameCustomerContact(reservation.proof.contact, current);
        const next = {
          ...latest,
          busyOperationId: null,
          ...(contactChanged
            ? { sent: false, verifiedUntil: null }
            : valid
              ? { sent: false, verifiedUntil: now() + 15 * 60000 }
              : {}),
        };
        await tx
          .update(returnVerifications)
          .set({ state: next })
          .where(eq(returnVerifications.id, id));
        return next;
      });
      if (contactChanged)
        throw new AppError(
          409,
          'CUSTOMER_CONTACT_CHANGED',
          'Customer contact changed. Request a new verification code.',
        );
      if (!valid)
        throw new AppError(
          422,
          'RETURN_OTP_INVALID',
          'The customer verification code is incorrect.',
        );
      return view(proof);
    },
  };
}
