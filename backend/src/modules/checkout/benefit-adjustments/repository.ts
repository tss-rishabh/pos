import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import { legacyZeroDateTime } from '../../../db/legacy-columns.js';
import type { Databases } from '../../../db/pools.js';
import { retryTransaction } from '../../../db/retry.js';
import {
  MUser,
  Order,
  PosSpecialPermissionActivityLog,
  PosUser,
  Product,
} from '../../../db/legacy-schema.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { assertCurrentOperatorRole } from '../../administration/authorization.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { activeCheckoutCustomer } from '../customer-access.js';
import { configuredStateStore, readJson, type PosStateStore } from '../state-store.js';
import {
  walletAdjustmentSchema,
  walletAdjustmentReceiptSchema,
  walletCustomerLookupSchema,
  walletCustomerSchema,
  type WalletAdjustmentInput,
  type WalletAdjustmentReceipt,
} from './contracts.js';
import {
  planWalletAdjustment,
  walletAdjustmentContract,
  walletCorrectionPatchHash,
} from './policy.js';
import { walletMoneyHistory, walletPointHistory } from './schema.js';

const denied = () =>
  new AppError(
    403,
    'BENEFIT_ADMINISTRATION_DENIED',
    'Global benefit administration requires a current internal administrator.',
  );
const missing = () =>
  new AppError(404, 'WALLET_ADJUSTMENT_NOT_FOUND', 'The wallet adjustment was not found.');
const unconfirmed = () =>
  new AppError(
    409,
    'WALLET_ADJUSTMENT_UNCONFIRMED',
    'The saved wallet adjustment requires reconciliation before another write.',
  );
const repair = () =>
  new AppError(409, 'WALLET_HISTORY_REPAIR_REQUIRED', 'The wallet history requires review.');
function money(value: number) {
  if (!Number.isFinite(value) || value < 0)
    throw new AppError(
      409,
      'WALLET_BALANCE_REPAIR_REQUIRED',
      'The wallet balance requires review.',
    );
  return value.toFixed(2);
}
/**
 * core/views.py:1284,1389 `advance_permisson("[1,2,3]")` on the AJAX views and
 * `user_type_exempt("[2]")` on the Special Permission page (core/views.py:1175-1176). The page
 * rule is enforced on the API as well (security decision).
 */
async function authorize(tx: AdministrationTransaction, user: Principal) {
  await assertCurrentOperatorRole(tx, user.id, [1, 2, 3]);
  const [identity] = await tx
    .select({ userType: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1);
  if (!identity || identity.userType === 2) throw denied();
}
const balances = {
  // Match the original Python text-protocol FLOAT read independent of Node's
  // prepared-protocol decoding. IDs are never cast through Number.
  money: sql<number>`CAST(${MUser.tss_money} AS CHAR)`.mapWith(Number),
  points: sql<number>`CAST(${MUser.tss_points} AS CHAR)`.mapWith(Number),
  cashback: sql<number>`CAST(${MUser.cashback} AS CHAR)`.mapWith(Number),
};
/**
 * Replaces `pos_rewrite_wallet_adjustments` (table-disposition.md checkout/wallet-adjustments):
 * `pos:wallet_adjustment:{operationId}` -> {operatorId, customerId, requestHash, executionId,
 * status, result}, SET NX EX 86400. It is also the in-flight claim. Legacy has no idempotency.
 */
const claimSchema = z
  .object({
    operatorId: identifier,
    customerId: identifier,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    executionId: z.uuid(),
    status: z.enum(['inflight', 'succeeded', 'uncertain']),
    result: walletAdjustmentReceiptSchema.nullable(),
  })
  .strict();
type Claim = z.infer<typeof claimSchema>;
export const walletAdjustmentKey = (operationId: string) => `pos:wallet_adjustment:${operationId}`;
const CLAIM_TTL_SECONDS = 86400;

export interface WalletAdjustmentOptions {
  stateStore?: PosStateStore;
  clock?: () => number;
}
export function walletAdjustmentRepository(
  db: Databases,
  config: Config,
  options: WalletAdjustmentOptions = {},
) {
  const clock = options.clock || Date.now,
    store = options.stateStore || configuredStateStore(config);
  const currentTime = () =>
    Temporal.Instant.fromEpochMilliseconds(clock()).toZonedDateTimeISO(config.BUSINESS_TIMEZONE);
  function settled(claim: Claim, user: Principal): WalletAdjustmentReceipt {
    if (claim.operatorId !== user.id) throw missing();
    if (claim.status !== 'succeeded' || !claim.result) throw unconfirmed();
    return claim.result;
  }
  return {
    async capabilities(user: Principal) {
      return db.get('writer').transaction(async (tx) => {
        await authorize(tx, user);
        return {
          enabled: true,
          contract: walletAdjustmentContract,
          patchHash: walletCorrectionPatchHash,
        };
      });
    },
    async lookup(user: Principal, supplied: { email: string }) {
      const input = walletCustomerLookupSchema.parse(supplied);
      return db.get('writer').transaction(async (tx) => {
        await authorize(tx, user);
        const rows = await db
          .get('primary')
          .select({
            id: MUser.id,
            firstName: MUser.firstname,
            lastName: MUser.lastname,
            active: MUser.status,
            blocked: MUser.is_block,
            disabled: MUser.is_disabled,
            ...balances,
          })
          .from(MUser)
          .where(eq(MUser.email, input.email))
          .orderBy(asc(MUser.id))
          .limit(2);
        // Legacy MUser.objects.filter(email=...).first(); "User Does not exists" when absent.
        if (!rows.length) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'User Does not exists');
        if (rows.length !== 1)
          throw new AppError(
            409,
            'CUSTOMER_IDENTITY_UNCONFIRMED',
            'A unique customer identity is required.',
          );
        const row = rows[0]!;
        if (!activeCheckoutCustomer(row))
          throw new AppError(
            409,
            'CUSTOMER_UNAVAILABLE',
            'This customer is not available for a wallet adjustment.',
          );
        return walletCustomerSchema.parse({
          id: String(row.id),
          name: `${row.firstName} ${row.lastName}`.trim(),
          money: money(row.money),
          points: money(row.points),
        });
      });
    },
    async get(user: Principal, operationId: string) {
      z.uuid().parse(operationId);
      await db.get('writer').transaction((tx) => authorize(tx, user));
      const claim = await readJson(store, walletAdjustmentKey(operationId), claimSchema);
      if (!claim) throw missing();
      return settled(claim, user);
    },
    /** AjaxTssMoneyView / AjaxAjaxTssPointsView (core/views.py:1285-1480), approved corrections. */
    async adjust(user: Principal, supplied: WalletAdjustmentInput) {
      const input = walletAdjustmentSchema.parse(supplied),
        requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        key = walletAdjustmentKey(input.operationId);
      await db.get('writer').transaction((tx) => authorize(tx, user));
      const claim: Claim = {
          operatorId: user.id,
          customerId: input.customerId,
          requestHash,
          executionId: randomUUID(),
          status: 'inflight',
          result: null,
        },
        serialized = JSON.stringify(claim);
      if (!(await store.set(key, serialized, CLAIM_TTL_SECONDS, true))) {
        const existing = await readJson(store, key, claimSchema);
        if (!existing) throw unconfirmed();
        if (
          existing.operatorId !== user.id ||
          existing.customerId !== input.customerId ||
          existing.requestHash !== requestHash
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This operation reference is bound to a different wallet adjustment.',
          );
        return settled(existing, user);
      }
      let result: WalletAdjustmentReceipt,
        bodyCompleted = false;
      try {
        result = await retryTransaction(() =>
          db.get('writer').transaction(async (tx) => {
            bodyCompleted = false;
            const value = await write(tx, user, input);
            bodyCompleted = true;
            return value;
          }),
        );
      } catch (error) {
        // A failure inside the transaction body rolled everything back: release the claim so the
        // same command can run again. A failure at COMMIT may have committed and stays frozen.
        if (!bodyCompleted || (error instanceof AppError && error.status < 500))
          await store.deleteIfEquals(key, serialized).catch(() => false);
        else
          await store
            .set(key, JSON.stringify({ ...claim, status: 'uncertain' }), CLAIM_TTL_SECONDS)
            .catch(() => undefined);
        throw error;
      }
      await store.set(
        key,
        JSON.stringify({ ...claim, status: 'succeeded', result }),
        CLAIM_TTL_SECONDS,
      );
      return result;
    },
  };
  async function write(
    tx: AdministrationTransaction,
    user: Principal,
    input: WalletAdjustmentInput,
  ): Promise<WalletAdjustmentReceipt> {
    await authorize(tx, user);
    const instant = currentTime(),
      now = instant.toPlainDateTime().toString({ smallestUnit: 'second' }).replace('T', ' '),
      date = instant.toPlainDate().toString();
    if (input.adjustment.expiry !== null && input.adjustment.expiry < date)
      throw new AppError(
        400,
        'WALLET_EXPIRY_INVALID',
        'The earning expiry cannot precede the current business date.',
      );
    // Lock optional reference rows before the wallet, matching the ordinary
    // order→customer lock order. Never attribute another customer's order.
    if (input.adjustment.orderId !== '0') {
      const [order] = await tx
        .select({ customerId: Order.user })
        .from(Order)
        .where(eq(Order.id, BigInt(input.adjustment.orderId)))
        .limit(1)
        .for('share');
      if (!order || String(order.customerId) !== input.customerId)
        throw new AppError(
          409,
          'WALLET_ORDER_REFERENCE_INVALID',
          'The order reference does not belong to this customer.',
        );
    }
    if (input.adjustment.productId !== '0') {
      const [product] = await tx
        .select({ id: Product.id })
        .from(Product)
        .where(eq(Product.id, BigInt(input.adjustment.productId)))
        .limit(1)
        .for('share');
      if (!product)
        throw new AppError(
          409,
          'WALLET_PRODUCT_REFERENCE_INVALID',
          'The product reference does not exist.',
        );
    }
    const [customer] = await tx
      .select({
        firstName: MUser.firstname,
        active: MUser.status,
        blocked: MUser.is_block,
        disabled: MUser.is_disabled,
        ...balances,
      })
      .from(MUser)
      .where(eq(MUser.id, BigInt(input.customerId)))
      .limit(1)
      .for('update');
    if (!customer || !activeCheckoutCustomer(customer))
      throw new AppError(
        409,
        'CUSTOMER_UNAVAILABLE',
        'This customer is not available for a wallet adjustment.',
      );
    const table = input.adjustment.asset === 'money' ? walletMoneyHistory : walletPointHistory;
    // core/views.py:1346-1367 / 1440-1461: FIFO over unexpired earnings, oldest first.
    const earnings =
      input.adjustment.direction === 'subtract'
        ? await tx
            .select({
              id: table.id,
              added: table.addedAmount,
              used: table.usedAmount,
              expired: table.expired,
              createdAt: table.createdAt,
            })
            .from(table)
            .where(
              and(
                eq(table.userId, BigInt(input.customerId)),
                eq(table.expired, 0),
                gt(table.addedAmount, 0),
              ),
            )
            .orderBy(asc(table.createdAt), asc(table.id))
            .limit(10001)
            .for('update')
        : [];
    const planned = planWalletAdjustment(
      input.adjustment,
      { money: customer.money, points: customer.points, cashback: customer.cashback },
      earnings.map((row) => {
        if (row.added === null || row.createdAt === null) throw repair();
        return {
          id: String(row.id),
          addedAmount: row.added,
          usedAmount: row.used,
          isExpired: row.expired !== 0,
          createdAt: row.createdAt,
        };
      }),
    );
    // Legacy writes added_user 0 and '' for an empty expiry (stored as the zero date).
    await tx.insert(table).values({
      userId: BigInt(input.customerId),
      orderId: BigInt(input.adjustment.orderId),
      productId: BigInt(input.adjustment.productId),
      addedAmount: planned.delta,
      usedAmount: 0,
      balanceBefore: planned.before,
      balanceAfter: planned.after,
      comment: input.adjustment.reason,
      platform: input.adjustment.platform,
      addedUser: 0n,
      createdAt: now,
      updatedAt: now,
      expiry: input.adjustment.expiry ? input.adjustment.expiry + ' 00:00:00' : legacyZeroDateTime,
      expired: 0,
    });
    const idResult = await tx.execute(sql`SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id`);
    const historyId = z
      .array(z.object({ id: identifier }))
      .length(1)
      .parse(idResult[0])[0]!.id;
    for (let offset = 0; offset < planned.consumed.length; offset += 200) {
      const batch = planned.consumed.slice(offset, offset + 200),
        cases = batch.map((row) => sql`WHEN ${BigInt(row.historyId)} THEN ${row.usedAmount}`);
      // Legacy updates only used_amt (core/views.py:1362-1365).
      await tx
        .update(table)
        .set({
          usedAmount: sql`CASE ${table.id} ${sql.join(cases, sql` `)} ELSE ${table.usedAmount} END`,
        })
        .where(
          and(
            eq(table.userId, BigInt(input.customerId)),
            inArray(
              table.id,
              batch.map((row) => BigInt(row.historyId)),
            ),
          ),
        );
    }
    await tx
      .update(MUser)
      .set(
        input.adjustment.asset === 'money'
          ? { tss_money: planned.after, updated_at: now }
          : { tss_points: planned.after, updated_at: now },
      )
      .where(eq(MUser.id, BigInt(input.customerId)));
    const [stored] = await tx
      .select(balances)
      .from(MUser)
      .where(eq(MUser.id, BigInt(input.customerId)))
      .limit(1);
    if (
      !stored ||
      stored.cashback !== customer.cashback ||
      Math.abs(stored[input.adjustment.asset] - planned.after) >= 0.005
    )
      throw repair();
    const amount = money(Number(input.adjustment.amount)),
      signed = (input.adjustment.direction === 'subtract' ? '-' : '') + amount;
    // helpers/helpers.py:740-756 special_permission_activity_logger, platform "Tss Money"/"Tss Points".
    await tx.insert(PosSpecialPermissionActivityLog).values({
      pos_user_id: BigInt(user.id),
      platform: input.adjustment.asset === 'money' ? 'Tss Money' : 'Tss Points',
      recipient: input.customerId,
      comment: `${input.adjustment.asset === 'money' ? 'Tss Money' : 'Tss Points'} ${signed} has been issued to user ${input.customerId}; ${input.adjustment.platform}; ${input.adjustment.reason}`,
      created_at: now,
      updated_at: now,
    });
    return walletAdjustmentReceiptSchema.parse({
      operationId: input.operationId,
      operatorId: user.id,
      customerId: input.customerId,
      asset: input.adjustment.asset,
      direction: input.adjustment.direction,
      amount,
      balanceBefore: money(planned.before),
      balanceAfter: money(stored[input.adjustment.asset]),
      historyId,
      consumedHistories: planned.consumed.length,
      contract: walletAdjustmentContract,
      patchHash: walletCorrectionPatchHash,
      createdAt: now,
    });
  }
}
