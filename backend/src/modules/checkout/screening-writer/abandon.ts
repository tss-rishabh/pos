import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { PosUser, Store, Order, OrderStore, HasProduct } from '../../../db/legacy-schema.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { operatorAuthEpochs } from '../../../auth/revocation.js';
import { identifier } from '../../../domain/validation.js';
import type { AdministrationTransaction, checkInService } from '../../administration/checkins.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkoutSessions } from '../schema.js';
import { checkoutStateSchema } from '../contracts.js';
import {
  financialTransaction,
  lockScreeningCustomer,
} from '../../legacy-order-imports/screening-transactions.js';
import {
  screeningReservations,
  screeningPurchases,
  screeningReservationSchema,
  screeningProof,
} from '../../legacy-order-imports/screening-profile.js';
import { equalImportHash } from '../../legacy-order-imports/financial-adapter-crypto.js';
import {
  publicScreeningHash,
  readPublicScreeningCreation,
  screeningReconciliationRequired,
} from './proof.js';
import {
  abandonPublicBenefits,
  readPublicBenefits,
  type PublicBenefitVerification,
} from './benefits.js';

const commandSchema = z
  .object({
    operationId: z.uuid(),
    sourceOperationId: z.uuid(),
    storeId: identifier,
    counterId: identifier,
    reason: z.enum(['cash-abandoned', 'stock-unavailable', 'operator-revoked']),
  })
  .strict();
export const publicScreeningAbandonmentCommandSchema = commandSchema;
export const publicScreeningAbandonmentSchema = z
  .object({
    contract: z.literal('pos-node-screening-abandonment-v1'),
    operationId: z.uuid(),
    commandId: z.uuid(),
    orderId: identifier,
    checkoutId: z.uuid(),
    actorId: identifier,
    customerId: identifier,
    storeId: identifier,
    counterId: identifier,
    creationHash: z.string().regex(/^[a-f0-9]{64}$/),
    reservationHash: z.string().regex(/^[a-f0-9]{64}$/),
    reason: commandSchema.shape.reason,
    noFinancialEffects: z.literal(true),
    benefits: z
      .object({
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        membership: z.enum(['unchanged', 'deactivated', 'prior-entitlement-restored']),
        quarantinedVoucherIds: z.array(identifier).max(100),
      })
      .strict()
      .optional(),
    createdAt: z.number().int().positive().safe(),
  })
  .strict();
type Abandonment = z.infer<typeof publicScreeningAbandonmentSchema>;
const zero = (value: unknown) =>
  value === null ||
  value === 0 ||
  value === '' ||
  value === '0' ||
  value === '0.0' ||
  value === '0.00';
async function absent(tx: AdministrationTransaction, statement: ReturnType<typeof sql>) {
  const [rows] = await tx.execute(statement);
  if (!Array.isArray(rows) || rows.length)
    throw new AppError(
      409,
      'SCREENING_FINANCIAL_RECONCILIATION_REQUIRED',
      'The order has financial work or an uncertain result. Keep its original reference for reconciliation.',
    );
}
/** Native tombstone. It changes no Order/HP/status, stock, wallet or cash field. */
export function publicScreeningAbandonment(
  options: {
    config: Pick<Config, 'BUSINESS_TIMEZONE'>;
    db: Databases;
    proofKey: string;
    checkins: Pick<ReturnType<typeof checkInService>, 'assertCheckIn'>;
    authSessionValid: (
      user: Principal,
      transaction?: AdministrationTransaction,
    ) => Promise<boolean>;
    clock?: () => number;
  } & PublicBenefitVerification,
) {
  const clock = options.clock ?? Date.now;
  return {
    async read(
      user: Principal,
      supplied: Omit<z.infer<typeof commandSchema>, 'reason'>,
    ): Promise<Abandonment | null> {
      const command = commandSchema.omit({ reason: true }).parse(supplied);
      if (!(await options.authSessionValid(user)))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      const result = await options.db.get('writer').transaction(
        async (tx) => {
          const [actor] = await tx
            .select({ active: PosUser.is_active, userType: PosUser.user_type })
            .from(PosUser)
            .where(eq(PosUser.id, BigInt(user.id)))
            .limit(1)
            .for('share');
          if (!actor?.active || actor.userType !== 1)
            throw new AppError(
              403,
              'ROLE_ACCESS_DENIED',
              'A current internal manager is required.',
            );
          await tx
            .select({ epoch: operatorAuthEpochs.epoch })
            .from(operatorAuthEpochs)
            .where(eq(operatorAuthEpochs.userId, user.id))
            .limit(1)
            .for('share');
          const [store] = await tx
            .select({ id: Store.id })
            .from(Store)
            .where(eq(Store.id, BigInt(command.storeId)))
            .limit(1)
            .for('update');
          if (!store) throw screeningReconciliationRequired();
          await assertCurrentStoreAccess(tx, user.id, command.storeId, [1, 2, 3]);
          await options.checkins.assertCheckIn(user.id, command.storeId, command.counterId, tx);
          const creation = await readPublicScreeningCreation(
            tx,
            command.sourceOperationId,
            options.proofKey,
          );
          if (
            !creation ||
            creation.storeId !== command.storeId ||
            creation.counterId !== command.counterId
          )
            return null;
          const [raw] = await tx.execute(
              sql`SELECT data,proof_hash FROM pos_rewrite_public_screening_abandonments WHERE operation_id=${command.sourceOperationId} AND command_id=${command.operationId} FOR SHARE`,
            ),
            rows = z
              .array(
                z.object({ data: z.unknown(), proof_hash: z.string().regex(/^[a-f0-9]{64}$/) }),
              )
              .max(1)
              .parse(raw);
          if (!rows.length) return null;
          const row = rows[0]!,
            proof = publicScreeningAbandonmentSchema.parse(
              typeof row.data === 'string' ? (JSON.parse(row.data) as unknown) : row.data,
            );
          if (
            proof.commandId !== command.operationId ||
            proof.operationId !== creation.operationId ||
            proof.orderId !== creation.orderId ||
            proof.checkoutId !== creation.checkoutId ||
            proof.customerId !== creation.customerId ||
            proof.storeId !== creation.storeId ||
            proof.counterId !== creation.counterId ||
            proof.creationHash !== publicScreeningHash(options.proofKey, 'creation', creation) ||
            !equalImportHash(
              publicScreeningHash(options.proofKey, 'abandonment', proof),
              row.proof_hash,
            )
          )
            throw screeningReconciliationRequired();
          return proof;
        },
        { isolationLevel: 'read committed' },
      );
      if (!(await options.authSessionValid(user)))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      return result;
    },
    async abandon(user: Principal, supplied: z.infer<typeof commandSchema>): Promise<Abandonment> {
      const command = commandSchema.parse(supplied);
      if (!(await options.authSessionValid(user)))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      const result = await financialTransaction(options.db, true, async (tx) => {
        const [actor] = await tx
          .select({ active: PosUser.is_active, userType: PosUser.user_type })
          .from(PosUser)
          .where(eq(PosUser.id, BigInt(user.id)))
          .limit(1)
          .for('share');
        if (!actor?.active || actor.userType !== 1)
          throw new AppError(403, 'ROLE_ACCESS_DENIED', 'A current internal manager is required.');
        await tx
          .select({ epoch: operatorAuthEpochs.epoch })
          .from(operatorAuthEpochs)
          .where(eq(operatorAuthEpochs.userId, user.id))
          .limit(1)
          .for('share');
        const [store] = await tx
          .select({ id: Store.id })
          .from(Store)
          .where(eq(Store.id, BigInt(command.storeId)))
          .limit(1)
          .for('update');
        if (!store) throw screeningReconciliationRequired();
        await assertCurrentStoreAccess(tx, user.id, command.storeId, [1, 2, 3]);
        await options.checkins.assertCheckIn(user.id, command.storeId, command.counterId, tx);
        if (!(await options.authSessionValid(user, tx)))
          throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
        const creation = await readPublicScreeningCreation(
          tx,
          command.sourceOperationId,
          options.proofKey,
        );
        if (
          !creation ||
          creation.storeId !== command.storeId ||
          creation.counterId !== command.counterId
        )
          throw screeningReconciliationRequired();
        const [existing] = await tx.execute(
          sql`SELECT data,proof_hash FROM pos_rewrite_public_screening_abandonments WHERE operation_id=${command.sourceOperationId} FOR SHARE`,
        );
        const prior = z
          .array(z.object({ data: z.unknown(), proof_hash: z.string().regex(/^[a-f0-9]{64}$/) }))
          .max(1)
          .parse(existing)[0];
        if (prior) {
          const proof = publicScreeningAbandonmentSchema.parse(
            typeof prior.data === 'string' ? (JSON.parse(prior.data) as unknown) : prior.data,
          );
          if (
            proof.commandId !== command.operationId ||
            proof.operationId !== creation.operationId ||
            proof.actorId !== user.id ||
            proof.orderId !== creation.orderId ||
            proof.storeId !== creation.storeId ||
            proof.counterId !== creation.counterId ||
            proof.customerId !== creation.customerId ||
            proof.creationHash !== publicScreeningHash(options.proofKey, 'creation', creation) ||
            proof.reason !== command.reason ||
            !equalImportHash(
              publicScreeningHash(options.proofKey, 'abandonment', proof),
              prior.proof_hash,
            )
          )
            throw screeningReconciliationRequired();
          return proof;
        }
        const [checkout] = await tx
          .select()
          .from(checkoutSessions)
          .where(eq(checkoutSessions.id, creation.checkoutId))
          .limit(1)
          .for('update');
        if (!checkout) throw screeningReconciliationRequired();
        const state = checkoutStateSchema.parse(checkout.state);
        if (
          state.operatorId !== creation.actorId ||
          state.storeId !== creation.storeId ||
          state.counterId !== creation.counterId ||
          (state.customerId ?? state.operatorCustomerId) !== creation.customerId ||
          !(
            (state.busyOperationId === creation.operationId && !state.orderId) ||
            (state.orderId === creation.orderId &&
              state.orderSubmissionOperationId === creation.operationId)
          )
        )
          throw screeningReconciliationRequired();
        await lockScreeningCustomer(tx, creation.customerId);
        const [order] = await tx
          .select()
          .from(Order)
          .where(eq(Order.id, BigInt(creation.orderId)))
          .limit(1)
          .for('update');
        if (
          !order ||
          String(order.user) !== creation.customerId ||
          order.order_statuses !== 0n ||
          order.payment_statuses !== 0n ||
          (order.payment_methods !== 3n && order.payment_methods !== 14n) ||
          [
            order.cashback_used,
            order.tss_money_used,
            order.tss_points_used,
            order.voucher_amt_used,
            order.coupon_amt_used,
          ].some((value) => value !== null && value !== 0) ||
          [
            order.voucher_used,
            order.coupon_used,
            order.parent_order_id,
            order.original_order_id,
          ].some((value) => value !== 0n)
        )
          throw screeningReconciliationRequired();
        const mappings = await tx
          .select()
          .from(OrderStore)
          .where(eq(OrderStore.order, order.id))
          .limit(2)
          .for('share');
        if (
          mappings.length !== 1 ||
          String(mappings[0]!.store) !== creation.storeId ||
          String(mappings[0]!.counter) !== creation.counterId ||
          [
            mappings[0]!.offline_payment,
            mappings[0]!.offline_payment_recieved,
            mappings[0]!.online_payment,
            mappings[0]!.online_other_payment,
          ].some((value) => !zero(value))
        )
          throw screeningReconciliationRequired();
        await absent(
          tx,
          sql`SELECT id FROM has_products WHERE order_id=${order.id} AND (status IS NULL OR status<>'INCOMPLETE') LIMIT 1`,
        );
        const benefitEvidence = await readPublicBenefits(tx, creation, options.proofKey);
        const ownedGiftLines = benefitEvidence?.gifts.map((gift) => gift.lineId) ?? [];
        await absent(
          tx,
          ownedGiftLines.length
            ? sql`SELECT id FROM has_products WHERE order_id=${order.id} AND gift_voucher_id<>0 AND id NOT IN (${sql.join(
                ownedGiftLines.map((id) => sql`${BigInt(id)}`),
                sql`, `,
              )}) LIMIT 1`
            : sql`SELECT id FROM has_products WHERE order_id=${order.id} AND gift_voucher_id<>0 LIMIT 1`,
        );
        if (!benefitEvidence?.membership)
          await absent(
            tx,
            sql`SELECT order_id FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=${order.id} LIMIT 1`,
          );
        const lines = await tx
            .select({ id: HasProduct.id, quantity: HasProduct.qty, sub: HasProduct.sub_prod_id })
            .from(HasProduct)
            .where(and(eq(HasProduct.order, order.id), eq(HasProduct.product, 390238n)))
            .orderBy(asc(HasProduct.id))
            .limit(3),
          markers = await tx
            .select()
            .from(screeningPurchases, { forceIndex: 'idx_order_id' })
            .where(eq(screeningPurchases.orderId, order.id))
            .orderBy(asc(screeningPurchases.id))
            .limit(3);
        if (
          lines.some((line) => line.sub !== 0n) ||
          markers.some((row) => String(row.customerId) !== creation.customerId) ||
          JSON.stringify(
            lines.map((line) => ({ id: String(line.id), quantity: Number(line.quantity) })),
          ) !== JSON.stringify(creation.lines) ||
          JSON.stringify(
            markers.map((row) => ({ id: String(row.id), lineId: String(row.lineId) })),
          ) !== JSON.stringify(creation.markers)
        )
          throw screeningReconciliationRequired();
        for (const statement of [
          sql`SELECT order_id FROM pos_rewrite_checkout_projections WHERE order_id=${order.id} LIMIT 1 FOR SHARE`,
          sql`SELECT id FROM pos_rewrite_payment_attempts WHERE order_id=${creation.orderId} LIMIT 1 FOR SHARE`,
          sql`SELECT id FROM pos_rewrite_payment_outbox WHERE order_id=${creation.orderId} LIMIT 1 FOR SHARE`,
          sql`SELECT order_id FROM order_tss_money WHERE order_id=${order.id} LIMIT 1`,
          sql`SELECT order_id FROM order_tss_point WHERE order_id=${order.id} LIMIT 1`,
          sql`SELECT order_id FROM gift_voucher_history WHERE order_id=${order.id} LIMIT 1`,
          sql`SELECT id FROM amount_to_be_refunded_log WHERE order_id=${order.id} AND is_refunded<>0 LIMIT 1`,
          sql`SELECT id FROM pos_rewrite_offline_cash_receipts WHERE (operator_id=${creation.actorId} AND draft_id=${state.draftId ?? ''}) OR order_id=${creation.orderId} LIMIT 1`,
          sql`SELECT receipt_id FROM pos_rewrite_offline_cash_order_links WHERE order_id=${creation.orderId} LIMIT 1`,
        ])
          await absent(tx, statement);
        const [reservation] = await tx
          .select()
          .from(screeningReservations)
          .where(eq(screeningReservations.operationId, creation.operationId))
          .limit(1)
          .for('update');
        if (!reservation) throw screeningReconciliationRequired();
        const held = screeningReservationSchema.parse(reservation.data),
          creationHash = publicScreeningHash(options.proofKey, 'creation', creation);
        if (
          held.kind !== 'pos' ||
          held.phase !== 'BOUND' ||
          held.orderId !== creation.orderId ||
          held.sourceReceiptHash !== creationHash ||
          !equalImportHash(screeningProof(options.proofKey, 'state', held), reservation.proofHash)
        )
          throw screeningReconciliationRequired();
        const [effects] = await tx.execute(
          sql`SELECT status,deliveries FROM pos_rewrite_public_screening_effects WHERE operation_id=${creation.operationId} FOR UPDATE`,
        );
        const effect = z
          .array(z.object({ status: z.literal('pending'), deliveries: z.unknown() }))
          .length(1)
          .parse(effects)[0]!;
        if (
          JSON.stringify(
            typeof effect.deliveries === 'string'
              ? (JSON.parse(effect.deliveries) as unknown)
              : effect.deliveries,
          ) !== '[]'
        )
          throw screeningReconciliationRequired();
        const now = clock(),
          restoredBenefits = await abandonPublicBenefits(
            tx,
            creation,
            options.proofKey,
            options,
            now,
          ),
          proof = publicScreeningAbandonmentSchema.parse({
            contract: 'pos-node-screening-abandonment-v1',
            operationId: creation.operationId,
            commandId: command.operationId,
            orderId: creation.orderId,
            checkoutId: creation.checkoutId,
            actorId: user.id,
            customerId: creation.customerId,
            storeId: creation.storeId,
            counterId: creation.counterId,
            creationHash,
            reservationHash: reservation.proofHash,
            reason: command.reason,
            noFinancialEffects: true,
            ...(restoredBenefits ? { benefits: restoredBenefits } : {}),
            createdAt: now,
          }),
          seal = publicScreeningHash(options.proofKey, 'abandonment', proof),
          released = screeningReservationSchema.parse({
            ...held,
            phase: 'REJECTED',
            orderId: null,
            lines: [],
            markers: [],
            sourceReceiptHash: null,
            completionHash: null,
            rejectionHash: seal,
            version: held.version + 1,
            updatedAt: now,
          });
        await tx.execute(
          sql`INSERT INTO pos_rewrite_public_screening_abandonments(operation_id,command_id,order_id,actor_id,data,proof_hash) VALUES(${creation.operationId},${command.operationId},${creation.orderId},${user.id},${JSON.stringify(proof)},${seal})`,
        );
        await tx
          .update(screeningReservations)
          .set({
            orderId: null,
            data: released,
            proofHash: screeningProof(options.proofKey, 'state', released),
          })
          .where(eq(screeningReservations.operationId, creation.operationId));
        await tx.execute(
          sql`UPDATE pos_rewrite_public_screening_effects SET status='cancelled',updated_at_ms=${now} WHERE operation_id=${creation.operationId}`,
        );
        return proof;
      });
      if (!(await options.authSessionValid(user)))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      return result;
    },
  };
}
