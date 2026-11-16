import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
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
import { activeCheckoutCustomer } from '../customer-access.js';
import { identifier } from '../../../domain/validation.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { assertCurrentOperatorRole } from '../../administration/authorization.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import {
  walletAdjustmentSchema,
  walletAdjustmentReceiptSchema,
  walletCustomerLookupSchema,
  walletCustomerSchema,
  type WalletAdjustmentInput,
} from './contracts.js';
import {
  planWalletAdjustment,
  walletAdjustmentContract,
  walletCorrectionPatchHash,
} from './policy.js';
import {
  walletAdjustments,
  walletConsumptions,
  walletMoneyHistory,
  walletPointHistory,
} from './schema.js';

export interface WalletAdjustmentEnvironment {
  GLOBAL_BENEFIT_ADJUSTMENT_CONTRACT?: string;
  GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT?: string;
}
export function walletAdjustmentEnvironment(): WalletAdjustmentEnvironment {
  return {
    GLOBAL_BENEFIT_ADJUSTMENT_CONTRACT: process.env.GLOBAL_BENEFIT_ADJUSTMENT_CONTRACT,
    GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT: process.env.GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT,
  };
}
const enabled = (environment: WalletAdjustmentEnvironment) =>
  environment.GLOBAL_BENEFIT_ADJUSTMENT_CONTRACT === walletAdjustmentContract &&
  environment.GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT === 'pos-wallet-user-lock-v1';
const denied = () =>
  new AppError(
    403,
    'BENEFIT_ADMINISTRATION_DENIED',
    'Global benefit administration requires a current internal administrator.',
  );
const missing = () =>
  new AppError(404, 'WALLET_ADJUSTMENT_NOT_FOUND', 'The wallet adjustment was not found.');
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
async function authorize(tx: AdministrationTransaction, user: Principal) {
  await assertCurrentOperatorRole(tx, user.id, [1, 2, 3]);
  const [identity] = await tx
    .select({ userType: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1);
  if (identity?.userType !== 1) throw denied();
}
const balances = {
  // Match the original Python text-protocol FLOAT read independent of Node's
  // prepared-protocol decoding. IDs are never cast through Number.
  money: sql<number>`CAST(${MUser.tss_money} AS CHAR)`.mapWith(Number),
  points: sql<number>`CAST(${MUser.tss_points} AS CHAR)`.mapWith(Number),
  cashback: sql<number>`CAST(${MUser.cashback} AS CHAR)`.mapWith(Number),
};
function receipt(row: typeof walletAdjustments.$inferSelect) {
  if (row.result === null)
    throw new AppError(
      503,
      'WALLET_ADJUSTMENT_UNCONFIRMED',
      'The wallet adjustment needs reconciliation.',
    );
  const result = walletAdjustmentReceiptSchema.parse(JSON.parse(row.result) as unknown);
  if (
    result.operationId !== row.id ||
    result.customerId !== row.customerId ||
    result.operatorId !== row.operatorId
  )
    throw new AppError(
      503,
      'WALLET_ADJUSTMENT_UNCONFIRMED',
      'The wallet adjustment evidence does not match.',
    );
  return result;
}
async function verifiedReceipt(
  tx: AdministrationTransaction,
  row: typeof walletAdjustments.$inferSelect,
) {
  try {
    const result = receipt(row),
      input = walletAdjustmentSchema.parse(JSON.parse(row.request) as unknown);
    if (
      input.operationId !== row.id ||
      input.customerId !== row.customerId ||
      createHash('sha256').update(JSON.stringify(input)).digest('hex') !== row.requestHash ||
      result.asset !== input.adjustment.asset ||
      result.direction !== input.adjustment.direction ||
      result.amount !== money(Number(input.adjustment.amount))
    )
      throw new AppError(
        503,
        'WALLET_ADJUSTMENT_UNCONFIRMED',
        'The wallet request evidence requires reconciliation.',
      );
    const table = result.asset === 'money' ? walletMoneyHistory : walletPointHistory;
    const [ledger] = await tx
      .select()
      .from(table)
      .where(
        and(eq(table.id, BigInt(result.historyId)), eq(table.userId, BigInt(result.customerId))),
      )
      .limit(1)
      .for('share');
    if (
      !ledger ||
      ledger.addedAmount === null ||
      ledger.balanceBefore === null ||
      ledger.balanceAfter === null
    )
      throw new AppError(
        503,
        'WALLET_ADJUSTMENT_UNCONFIRMED',
        'The wallet ledger evidence is missing.',
      );
    const bindings = {
      amount:
        ledger.addedAmount ===
        Number(input.adjustment.amount) * (input.adjustment.direction === 'subtract' ? -1 : 1),
      balance:
        money(ledger.balanceBefore) === result.balanceBefore &&
        money(ledger.balanceAfter) === result.balanceAfter,
      order: String(ledger.orderId) === input.adjustment.orderId,
      product: String(ledger.productId) === input.adjustment.productId,
      actor: String(ledger.addedUser) === row.operatorId,
      platform: ledger.platform === input.adjustment.platform,
      reason: ledger.comment === input.adjustment.reason,
      expiry:
        ledger.expiry === (input.adjustment.expiry ? input.adjustment.expiry + ' 00:00:00' : null),
      timestamp: ledger.createdAt === result.createdAt,
    };
    const invalid = Object.entries(bindings).find(([, valid]) => !valid)?.[0];
    if (invalid)
      throw new AppError(
        503,
        'WALLET_ADJUSTMENT_UNCONFIRMED',
        `The wallet ${invalid} evidence requires reconciliation.`,
      );
    // Locking current reads must also cover allocation evidence. A plain
    // aggregate can retain a pre-commit REPEATABLE READ snapshot after waiting
    // on the command row and incorrectly reject a successful concurrent replay.
    const consumed = await tx
      .select({
        asset: walletConsumptions.asset,
        before: walletConsumptions.usedBefore,
        after: walletConsumptions.usedAfter,
      })
      .from(walletConsumptions)
      .where(eq(walletConsumptions.operationId, row.id))
      .orderBy(asc(walletConsumptions.historyId))
      .limit(10001)
      .for('share');
    if (consumed.length !== result.consumedHistories)
      throw new AppError(
        503,
        'WALLET_ADJUSTMENT_UNCONFIRMED',
        'The wallet allocation count requires reconciliation.',
      );
    if (
      consumed.some(
        (value) =>
          value.asset !== result.asset ||
          !Number.isFinite(value.before) ||
          !Number.isFinite(value.after) ||
          value.after <= value.before,
      )
    )
      throw new AppError(
        503,
        'WALLET_ADJUSTMENT_UNCONFIRMED',
        'The wallet allocation bounds require reconciliation.',
      );
    return result;
  } catch (error) {
    if (error instanceof AppError && error.code === 'WALLET_ADJUSTMENT_UNCONFIRMED') throw error;
    throw new AppError(
      503,
      'WALLET_ADJUSTMENT_UNCONFIRMED',
      'The original wallet adjustment ledger requires reconciliation.',
    );
  }
}

export function walletAdjustmentRepository(
  db: Databases,
  timeZone: string,
  environment: WalletAdjustmentEnvironment = walletAdjustmentEnvironment(),
  clock: () => number = Date.now,
) {
  const currentTime = () =>
    Temporal.Instant.fromEpochMilliseconds(clock()).toZonedDateTimeISO(timeZone);
  return {
    async capabilities(user: Principal) {
      return db.get('writer').transaction(async (tx) => {
        await authorize(tx, user);
        return {
          enabled: enabled(environment),
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
      return db.get('writer').transaction(async (tx) => {
        await authorize(tx, user);
        const [row] = await tx
          .select()
          .from(walletAdjustments)
          .where(
            and(eq(walletAdjustments.id, operationId), eq(walletAdjustments.operatorId, user.id)),
          )
          .limit(1)
          .for('share');
        if (!row) throw missing();
        return verifiedReceipt(tx, row);
      });
    },
    async adjust(user: Principal, supplied: WalletAdjustmentInput) {
      const input = walletAdjustmentSchema.parse(supplied),
        requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        executionId = randomUUID();
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await authorize(tx, user);
          if (!enabled(environment))
            throw new AppError(
              503,
              'WALLET_ADJUSTMENTS_NOT_CONFIGURED',
              'The approved wallet and shared-writer locking contracts are required.',
            );
          const instant = currentTime(),
            now = instant.toPlainDateTime().toString({ smallestUnit: 'second' }).replace('T', ' '),
            date = instant.toPlainDate().toString();
          await tx
            .insert(walletAdjustments)
            .values({
              id: input.operationId,
              operatorId: user.id,
              customerId: input.customerId,
              requestHash,
              executionId,
              request: JSON.stringify(input),
              result: null,
              requestId: currentRequestTrace()?.requestId || null,
              createdAt: now,
            })
            .onDuplicateKeyUpdate({ set: { id: sql`${walletAdjustments.id}` } });
          const [operation] = await tx
            .select()
            .from(walletAdjustments)
            .where(eq(walletAdjustments.id, input.operationId))
            .for('update');
          if (
            !operation ||
            operation.operatorId !== user.id ||
            operation.customerId !== input.customerId ||
            operation.requestHash !== requestHash
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This operation reference is bound to a different wallet adjustment.',
            );
          if (operation.result !== null) return verifiedReceipt(tx, operation);
          if (operation.executionId !== executionId)
            throw new AppError(
              503,
              'WALLET_ADJUSTMENT_UNCONFIRMED',
              'The saved wallet adjustment requires reconciliation before another write.',
            );
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
          const table =
            input.adjustment.asset === 'money' ? walletMoneyHistory : walletPointHistory;
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
          // Date-only expiry is the original source midnight in business wall time;
          // no invented validity period or timezone/session mutation is used.
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
            addedUser: BigInt(user.id),
            createdAt: now,
            updatedAt: now,
            expiry: input.adjustment.expiry ? input.adjustment.expiry + ' 00:00:00' : null,
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
            await tx
              .update(table)
              .set({
                usedAmount: sql`CASE ${table.id} ${sql.join(cases, sql` `)} ELSE ${table.usedAmount} END`,
                updatedAt: now,
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
            await tx.insert(walletConsumptions).values(
              batch.map((row) => ({
                operationId: input.operationId,
                historyId: row.historyId,
                asset: input.adjustment.asset,
                usedBefore: row.usedBefore,
                usedAfter: row.usedAmount,
              })),
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
          const result = walletAdjustmentReceiptSchema.parse({
            operationId: input.operationId,
            operatorId: user.id,
            customerId: input.customerId,
            asset: input.adjustment.asset,
            direction: input.adjustment.direction,
            amount: money(Number(input.adjustment.amount)),
            balanceBefore: money(planned.before),
            balanceAfter: money(stored[input.adjustment.asset]),
            historyId,
            consumedHistories: planned.consumed.length,
            contract: walletAdjustmentContract,
            patchHash: walletCorrectionPatchHash,
            createdAt: now,
          });
          await tx.insert(PosSpecialPermissionActivityLog).values({
            pos_user_id: BigInt(user.id),
            platform: input.adjustment.asset === 'money' ? 'Tss Money' : 'Tss Points',
            recipient: input.customerId,
            comment: `Wallet adjustment ${input.operationId}; ${input.adjustment.direction} ${result.amount}; ${input.adjustment.platform}; ${input.adjustment.reason}`,
            created_at: now,
            updated_at: now,
          });
          await tx
            .update(walletAdjustments)
            .set({ result: JSON.stringify(result) })
            .where(eq(walletAdjustments.id, input.operationId));
          return verifiedReceipt(tx, { ...operation, result: JSON.stringify(result) });
        }),
      );
    },
  };
}
