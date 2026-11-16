import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { generatedId } from '../../db/generated-id.js';
import {
  GiftCardCollection,
  MUser,
  PosSpecialPermissionActivityLog,
} from '../../db/legacy-schema.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { currentRequestTrace } from '../../observability/context.js';
import {
  assertCurrentOperatorRole,
  assertCurrentStoreAccess,
} from '../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import { activeCheckoutCustomer } from '../checkout/customer-access.js';
import { checkoutStateSchema } from '../checkout/contracts.js';
import {
  readCustomerContactBinding,
  sameCustomerContact,
} from '../checkout/customer-contact-authority.js';
import {
  giftCardIssuanceContract,
  giftCardIssuances,
  giftCardIssuanceHashSql,
} from '../checkout/gift-card-issuance.js';
import { walletMoneyHistory } from '../checkout/benefit-adjustments/schema.js';
import { checkoutSessions } from '../checkout/schema.js';
import { contactActorVersion } from '../customer-contacts/authority.js';
import type { customerOtpService } from '../customer-otp/service.js';
import { sourceGiftCardPin } from '../gift-card-batches/generation.js';
import {
  assertConversionCart,
  assertVoucherLegacyCompatibility,
  authorizeVoucherIssuer,
} from './authorization.js';
import {
  exactVoucherValueContract,
  globalVoucherContract,
  nonExpiringVoucherContract,
  voucherCancellationSchema,
  voucherConversionSchema,
  voucherIssuanceSchema,
  voucherLookupSchema,
  voucherReceiptSchema,
  voucherSelectionSchema,
  type VoucherCancellation,
  type VoucherConversion,
  type VoucherIssuance,
} from './contracts.js';
import {
  pinErrorCodes,
  voucherChanged,
  voucherConflict,
  voucherMissing,
  voucherPinError,
  voucherUnavailable,
  type VoucherPinError,
} from './errors.js';
import { globalCoupons, globalVoucherHistory, globalVouchers } from './legacy-schema.js';
import type { GlobalVoucherOptions } from './options.js';
import {
  giftCardDatesValid,
  planVoucherConversion,
  storedVoucherMinorUnits,
  voucherAmountString,
  voucherIntegrity,
  voucherMinorUnits,
} from './policy.js';
import {
  verifiedVoucherReceipt,
  voucherEvidenceUnavailable,
  type VoucherOperation,
} from './receipts.js';
import { voucherOperations, voucherPinBudgets, voucherSelections } from './schema.js';

export interface GlobalVoucherDependencies {
  customerOtp?: Pick<ReturnType<typeof customerOtpService>, 'assertVerified'>;
}
const customerProjection = {
  id: MUser.id,
  email: MUser.email,
  firstName: MUser.firstname,
  lastName: MUser.lastname,
  active: MUser.status,
  blocked: MUser.is_block,
  disabled: MUser.is_disabled,
  money: sql<number>`CAST(${MUser.tss_money} AS CHAR)`.mapWith(Number),
  cashback: sql<number>`CAST(${MUser.cashback} AS CHAR)`.mapWith(Number),
};
const viewError = z.enum(pinErrorCodes);
export function globalVoucherService(
  config: Config,
  db: Databases,
  options: GlobalVoucherOptions,
  dependencies: GlobalVoucherDependencies = {},
  clock: () => number = Date.now,
  createCode: () => string = () => 'GFV' + randomBytes(11).toString('hex').toUpperCase(),
) {
  const checkIns = checkInService(db, config);
  function enabled() {
    return (
      !config.DEMO_MODE &&
      options.GLOBAL_VOUCHERS_ENABLED &&
      options.GLOBAL_VOUCHERS_CONTRACT === globalVoucherContract &&
      options.GLOBAL_VOUCHER_LEGACY_CONTRACT === nonExpiringVoucherContract &&
      options.GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT === 'pos-wallet-user-lock-v1' &&
      Boolean(options.GLOBAL_VOUCHER_SECRET)
    );
  }
  function ready() {
    if (!enabled()) throw voucherUnavailable();
    return options.GLOBAL_VOUCHER_SECRET!;
  }
  function hash(secret: string, kind: string, value: unknown) {
    return createHmac('sha256', secret)
      .update(kind + '\0' + JSON.stringify(value))
      .digest('hex');
  }
  function wall() {
    return Temporal.Instant.fromEpochMilliseconds(clock())
      .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  }
  async function customer(tx: AdministrationTransaction, id: string) {
    const [row] = await tx
      .select(customerProjection)
      .from(MUser)
      .where(eq(MUser.id, BigInt(id)))
      .limit(1)
      .for('update');
    if (!row || !activeCheckoutCustomer(row))
      throw new AppError(
        409,
        'VOUCHER_CUSTOMER_UNAVAILABLE',
        'A unique active customer is required.',
      );
    return row;
  }
  async function operation(
    tx: AdministrationTransaction,
    fields: {
      id: string;
      operatorId: string;
      customerId: string;
      kind: 'issuance' | 'conversion';
      requestHash: string;
      storeId?: string;
      checkoutId?: string;
    },
  ) {
    const executionId = randomUUID();
    await tx
      .insert(voucherOperations)
      .values({
        ...fields,
        executionId,
        createdAt: wall(),
        requestId: currentRequestTrace()?.requestId || null,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${voucherOperations.id}` } });
    const [row] = await tx
      .select()
      .from(voucherOperations)
      .where(eq(voucherOperations.id, fields.id))
      .limit(1)
      .for('update');
    if (
      !row ||
      row.operatorId !== fields.operatorId ||
      row.customerId !== fields.customerId ||
      row.kind !== fields.kind ||
      row.requestHash !== fields.requestHash ||
      row.storeId !== (fields.storeId ?? null) ||
      row.checkoutId !== (fields.checkoutId ?? null)
    )
      throw voucherConflict();
    return { row, fresh: row.executionId === executionId };
  }
  async function replay(tx: AdministrationTransaction, operation: VoucherOperation) {
    if (operation.result !== null || operation.errorCode !== null)
      return verifiedVoucherReceipt(tx, operation);
    return voucherEvidenceUnavailable();
  }
  async function save(
    tx: AdministrationTransaction,
    operation: VoucherOperation,
    supplied: unknown,
  ) {
    const result = voucherReceiptSchema.parse(supplied);
    await tx
      .update(voucherOperations)
      .set({ result })
      .where(eq(voucherOperations.id, operation.id));
    return verifiedVoucherReceipt(tx, { ...operation, result });
  }
  async function audit(
    tx: AdministrationTransaction,
    user: Principal,
    customerId: string,
    kind: string,
    id: string,
    now: string,
  ) {
    await tx.insert(PosSpecialPermissionActivityLog).values({
      pos_user_id: BigInt(user.id),
      platform: kind === 'issuance' ? 'Gift Voucher' : 'Gift Voucher Conversion',
      recipient: customerId,
      comment: `Voucher ${kind}; operation ${id}; customer ${customerId}`,
      created_at: now,
      updated_at: now,
    });
  }
  async function pin(
    tx: AdministrationTransaction,
    voucher: typeof globalVouchers.$inferSelect,
    supplied: string | undefined,
  ): Promise<VoucherPinError | null> {
    if (
      voucher.kind !== 'GIFT_CARD' ||
      !voucher.requiresPin ||
      !options.GLOBAL_VOUCHER_GIFT_CARD_PIN_REQUIRED
    )
      return null;
    if (!supplied) return 'GIFT_CARD_PIN_REQUIRED';
    const now = clock(),
      window = options.GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT_EX * 1000;
    await tx
      .insert(voucherPinBudgets)
      .values({ voucherId: String(voucher.id), failures: 0, windowStartedAt: now })
      .onDuplicateKeyUpdate({ set: { voucherId: sql`${voucherPinBudgets.voucherId}` } });
    const [budget] = await tx
      .select()
      .from(voucherPinBudgets)
      .where(eq(voucherPinBudgets.voucherId, String(voucher.id)))
      .limit(1)
      .for('update');
    if (
      !budget ||
      !Number.isSafeInteger(budget.windowStartedAt) ||
      budget.windowStartedAt < 0 ||
      !Number.isInteger(budget.failures) ||
      budget.failures < 0 ||
      budget.failures > 6
    )
      return voucherEvidenceUnavailable();
    const failures = now - budget.windowStartedAt >= window ? 0 : budget.failures;
    if (failures >= options.GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT) return 'GIFT_CARD_PIN_LIMIT';
    const expected = sourceGiftCardPin(String(voucher.serial));
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    ) {
      await tx
        .update(voucherPinBudgets)
        // Source Redis SET(..., ex=GC_PIN_LIMIT_EX) refreshes the lifetime for
        // each new wrong intent. Replays and an already-blocked attempt do not.
        .set({ failures: failures + 1, windowStartedAt: now })
        .where(eq(voucherPinBudgets.voucherId, String(voucher.id)));
      return 'GIFT_CARD_PIN_INVALID';
    }
    await tx.delete(voucherPinBudgets).where(eq(voucherPinBudgets.voucherId, String(voucher.id)));
    return null;
  }
  return {
    async capabilities(user: Principal) {
      if (!enabled()) {
        if (user.userType !== 1 || ![1, 2, 3].includes(user.role))
          throw new AppError(
            403,
            'GLOBAL_VOUCHER_ACCESS_DENIED',
            'Gift voucher issuance requires an internal administrator.',
          );
        return {
          enabled: false,
          conversionEnabled: false,
          exactCents: true,
          nonExpiring: true as const,
          contract: globalVoucherContract,
        };
      }
      return db.get('writer').transaction(async (tx) => {
        await authorizeVoucherIssuer(tx, user);
        return {
          enabled: enabled(),
          conversionEnabled:
            enabled() &&
            options.GLOBAL_VOUCHER_CONVERSION_ENABLED &&
            Boolean(dependencies.customerOtp),
          exactCents: options.GLOBAL_VOUCHER_VALUE_CONTRACT === exactVoucherValueContract,
          nonExpiring: true as const,
          contract: globalVoucherContract,
        };
      });
    },
    async conversionCapabilities(user: Principal, storeId: string, checkoutId: string) {
      identifier.parse(storeId);
      z.uuid().parse(checkoutId);
      requireStore(user, storeId);
      if (!enabled() || !options.GLOBAL_VOUCHER_CONVERSION_ENABLED || !dependencies.customerOtp)
        return { enabled: false };
      return db.get('writer').transaction(async (tx) => {
        await checkIns.assertCheckIn(user.id, storeId, undefined, tx);
        const [row] = await tx
          .select({ state: checkoutSessions.state })
          .from(checkoutSessions)
          .where(
            and(
              eq(checkoutSessions.id, checkoutId),
              eq(checkoutSessions.storeId, storeId),
              eq(checkoutSessions.operatorId, user.id),
            ),
          )
          .limit(1)
          .for('share');
        if (!row) throw voucherChanged();
        return {
          enabled:
            enabled() &&
            options.GLOBAL_VOUCHER_CONVERSION_ENABLED &&
            Boolean(dependencies.customerOtp),
        };
      });
    },
    async lookup(user: Principal, supplied: { email: string }) {
      const input = voucherLookupSchema.parse(supplied);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await authorizeVoucherIssuer(tx, user);
          ready();
          const candidates = await db
            .get('primary')
            .select({ id: MUser.id })
            .from(MUser)
            .where(eq(MUser.email, input.email))
            .orderBy(asc(MUser.id))
            .limit(2);
          if (candidates.length !== 1)
            throw new AppError(
              409,
              'CUSTOMER_IDENTITY_UNCONFIRMED',
              'A unique current customer is required.',
            );
          // Lock the primary key once, without first holding email/share locks
          // that concurrent lookups would both need to upgrade.
          const id = String(candidates[0]!.id),
            current = await customer(tx, id);
          // Authorizer/customer reads above are locking current reads. This first
          // consistent writer read therefore starts after acquiring that PK lock.
          const exact = await tx
            .select({ id: MUser.id })
            .from(MUser)
            .where(eq(MUser.email, input.email))
            .orderBy(asc(MUser.id))
            .limit(2);
          if (candidates.length !== 1 || exact.length !== 1 || candidates[0]!.id !== exact[0]!.id)
            throw new AppError(
              409,
              'CUSTOMER_IDENTITY_UNCONFIRMED',
              'A unique current customer is required.',
            );
          const contact = await readCustomerContactBinding(tx, id),
            actorVersion = await contactActorVersion(tx, user.id),
            selectionId = randomUUID(),
            expiresAt = clock() + 300_000;
          await tx.insert(voucherSelections).values({
            id: selectionId,
            customerId: id,
            operatorId: user.id,
            actorVersion,
            contact,
            expiresAt,
          });
          return voucherSelectionSchema.parse({
            selectionId,
            customerId: id,
            name: `${current.firstName} ${current.lastName}`,
            expiresAt,
          });
        }),
      );
    },
    async get(user: Principal, id: string) {
      z.uuid().parse(id);
      return db.get('writer').transaction(async (tx) => {
        await assertCurrentOperatorRole(tx, user.id, [1, 2, 3, 4, 5]);
        const [row] = await tx
          .select()
          .from(voucherOperations)
          .where(and(eq(voucherOperations.id, id), eq(voucherOperations.operatorId, user.id)))
          .limit(1)
          .for('share');
        if (!row) throw voucherMissing();
        if (row.kind === 'issuance') await authorizeVoucherIssuer(tx, user);
        else {
          if (!row.storeId) voucherEvidenceUnavailable();
          requireStore(user, row.storeId);
          await assertCurrentStoreAccess(tx, user.id, row.storeId);
        }
        if (row.errorCode === 'VOUCHER_CANCELLED')
          return { status: 'cancelled' as const, errorCode: null, receipt: null };
        if (row.errorCode)
          return {
            status: 'rejected' as const,
            errorCode: viewError.parse(row.errorCode),
            receipt: null,
          };
        return {
          status: 'succeeded' as const,
          errorCode: null,
          receipt: await verifiedVoucherReceipt(tx, row),
        };
      });
    },
    async cancel(user: Principal, operationId: string, supplied: VoucherCancellation) {
      z.uuid().parse(operationId);
      const input = voucherCancellationSchema.parse(supplied);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await assertCurrentOperatorRole(tx, user.id, [1, 2, 3, 4, 5]);
          let customerId: string;
          if (input.kind === 'issuance') {
            await authorizeVoucherIssuer(tx, user);
            const [selection] = await tx
              .select({ customerId: voucherSelections.customerId })
              .from(voucherSelections)
              .where(
                and(
                  eq(voucherSelections.id, input.selectionId),
                  eq(voucherSelections.operatorId, user.id),
                ),
              )
              .limit(1)
              .for('update');
            if (!selection) throw voucherChanged();
            customerId = selection.customerId;
          } else {
            requireStore(user, input.storeId);
            await assertCurrentStoreAccess(tx, user.id, input.storeId);
            const [checkout] = await tx
              .select({ state: checkoutSessions.state })
              .from(checkoutSessions)
              .where(
                and(
                  eq(checkoutSessions.id, input.checkoutId),
                  eq(checkoutSessions.operatorId, user.id),
                  eq(checkoutSessions.storeId, input.storeId),
                ),
              )
              .limit(1)
              .for('update');
            const state = checkoutStateSchema.safeParse(checkout?.state);
            if (!state.success || !state.data.customerId) throw voucherChanged();
            customerId = state.data.customerId;
          }
          // This PK competes with the financial INSERT in the same order. A prior
          // commit wins and returns its receipt; an absent command is fenced forever.
          await tx
            .insert(voucherOperations)
            .values({
              id: operationId,
              operatorId: user.id,
              customerId,
              kind: input.kind,
              requestHash: randomBytes(32).toString('hex'),
              executionId: randomUUID(),
              errorCode: 'VOUCHER_CANCELLED',
              storeId: input.kind === 'conversion' ? input.storeId : null,
              checkoutId: input.kind === 'conversion' ? input.checkoutId : null,
              createdAt: wall(),
              requestId: currentRequestTrace()?.requestId || null,
            })
            .onDuplicateKeyUpdate({ set: { id: sql`${voucherOperations.id}` } });
          const [row] = await tx
            .select()
            .from(voucherOperations)
            .where(eq(voucherOperations.id, operationId))
            .limit(1)
            .for('update');
          if (
            !row ||
            row.operatorId !== user.id ||
            row.kind !== input.kind ||
            (input.kind === 'conversion' &&
              (row.storeId !== input.storeId || row.checkoutId !== input.checkoutId))
          )
            throw voucherConflict();
          if (row.errorCode === 'VOUCHER_CANCELLED')
            return { status: 'cancelled' as const, errorCode: null, receipt: null };
          if (row.errorCode)
            return {
              status: 'rejected' as const,
              errorCode: viewError.parse(row.errorCode),
              receipt: null,
            };
          return {
            status: 'succeeded' as const,
            errorCode: null,
            receipt: await verifiedVoucherReceipt(tx, row),
          };
        }),
      );
    },
    async issue(user: Principal, supplied: VoucherIssuance) {
      const input = voucherIssuanceSchema.parse(supplied),
        secret = ready(),
        minor = voucherMinorUnits(input.amount);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await authorizeVoucherIssuer(tx, user);
          const [selection] = await tx
            .select()
            .from(voucherSelections)
            .where(
              and(
                eq(voucherSelections.id, input.selectionId),
                eq(voucherSelections.operatorId, user.id),
              ),
            )
            .limit(1)
            .for('update');
          if (!selection) throw voucherChanged();
          const command = await operation(tx, {
            id: input.operationId,
            operatorId: user.id,
            customerId: selection.customerId,
            kind: 'issuance',
            requestHash: hash(secret, 'issuance', input),
          });
          if (!command.fresh) return replay(tx, command.row);
          if (
            selection.expiresAt <= clock() ||
            selection.consumedBy !== null ||
            selection.actorVersion !== (await contactActorVersion(tx, user.id))
          )
            throw voucherChanged();
          const current = await customer(tx, selection.customerId),
            binding = await readCustomerContactBinding(tx, selection.customerId);
          if (!sameCustomerContact(binding, selection.contact)) throw voucherChanged();
          await assertVoucherLegacyCompatibility(tx);
          const now = wall(),
            code = z
              .string()
              .regex(/^GFV[A-Z0-9]{1,22}$/)
              .parse(createCode()),
            amount = voucherAmountString(minor),
            numeric = Number(amount),
            name = current.firstName + current.lastName;
          if (name.length > 100 || [...name].some((character) => character.codePointAt(0)! > 255))
            throw new AppError(
              409,
              'VOUCHER_RECIPIENT_UNSUPPORTED',
              'The recipient name cannot be stored safely in the legacy voucher schema.',
            );
          const couponId = generatedId(
            await tx.insert(globalCoupons).values({
              userId: current.id,
              fromId: 'connect@thesouledstore.com',
              fromName: 'The Souled Store',
              toId: current.email,
              toName: name,
              code,
              name: code,
              quantity: 0n,
              type: '3',
              image: '',
              offer: 0,
              validFor: 0,
              value: Math.round(numeric),
              initialValue: numeric,
              specific: 0,
              category: '3',
              deleted: 0,
              internEmail: '',
              artist: '',
              remaining: 0,
              theme: '0',
              message: '',
              startsAt: now,
              expiresAt: null,
              minimum: 0,
              count: 0,
              lot: '',
              paymentMethod: '',
              transactionId: '',
              transactionStatus: '',
              transactionOrderId: 0n,
              requestedBy: '',
              newUser: 0,
              userType: 0,
              percentageMaximum: '',
              buyableQuantity: 0n,
              freeQuantity: 0n,
              mixedType: '',
              createdAt: now,
              updatedAt: now,
            }),
          );
          const voucherId = generatedId(
            await tx.insert(globalVouchers).values({
              customerId: current.id,
              recipient: current.email,
              code,
              theme: 0,
              name,
              phone: 0n,
              value: numeric,
              initialValue: numeric,
              message: '',
              status: 1,
              orderId: 0n,
              couponId,
              collectionId: 0n,
              kind: 'GIFT_VOUCHER',
              serial: 0n,
              requiresPin: 0,
              platform: 'both',
              startsAt: null,
              expiresAt: null,
              createdAt: now,
              updatedAt: now,
            }),
          );
          const historyId = generatedId(
            await tx.insert(globalVoucherHistory).values({
              userId: current.id,
              orderId: 0n,
              voucherId,
              amount: numeric,
              before: 0,
              after: numeric,
              comment: 'GV ADD: Gift Voucher Amount Added',
              platform: 'GV_ADD',
              operatorId: BigInt(user.id),
              createdAt: now,
              updatedAt: now,
              bulk: 0,
            }),
          );
          await audit(tx, user, String(current.id), 'issuance', input.operationId, now);
          await tx
            .update(voucherSelections)
            .set({ consumedBy: input.operationId })
            .where(eq(voucherSelections.id, input.selectionId));
          return save(tx, command.row, {
            operationId: input.operationId,
            kind: 'issuance',
            operatorId: user.id,
            customerId: String(current.id),
            voucherId: String(voucherId),
            couponId: String(couponId),
            voucherCode: code,
            amount,
            voucherHistoryId: String(historyId),
            moneyHistoryId: null,
            walletBefore: null,
            walletAfter: null,
            nonExpiring: true,
            createdAt: now,
            contract: globalVoucherContract,
            valueContract: exactVoucherValueContract,
            checkoutId: null,
            checkoutVersion: null,
            status: 'success',
            message: `Gift Voucher ${code} Has been created for ${current.email} and amount is ${input.amount}`,
          });
        }),
      );
    },
    async convert(
      user: Principal,
      storeId: string,
      checkoutId: string,
      supplied: VoucherConversion,
    ) {
      identifier.parse(storeId);
      z.uuid().parse(checkoutId);
      const input = voucherConversionSchema.parse(supplied),
        secret = ready();
      requireStore(user, storeId);
      if (!options.GLOBAL_VOUCHER_CONVERSION_ENABLED || !dependencies.customerOtp)
        throw voucherUnavailable();
      const otp = dependencies.customerOtp;
      const outcome = await retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await checkIns.assertCheckIn(user.id, storeId, undefined, tx);
          const [saved] = await tx
            .select()
            .from(checkoutSessions)
            .where(
              and(
                eq(checkoutSessions.id, checkoutId),
                eq(checkoutSessions.operatorId, user.id),
                eq(checkoutSessions.storeId, storeId),
              ),
            )
            .limit(1)
            .for('update');
          const parsed = checkoutStateSchema.safeParse(saved?.state);
          if (!parsed.success || !parsed.data.customerId) throw voucherChanged();
          const state = parsed.data;
          const command = await operation(tx, {
            id: input.operationId,
            kind: 'conversion',
            operatorId: user.id,
            customerId: state.customerId!,
            storeId,
            checkoutId,
            requestHash: hash(secret, 'conversion', [storeId, checkoutId, input]),
          });
          if (!command.fresh) {
            if (command.row.errorCode)
              return { error: viewError.parse(command.row.errorCode), receipt: null };
            return { error: null, receipt: await replay(tx, command.row) };
          }
          if (
            state.version !== saved?.version ||
            state.version !== input.expectedVersion ||
            !['open', 'quoted'].includes(state.phase) ||
            state.orderId ||
            state.busyOperationId ||
            state.draftImport?.status === 'pending'
          )
            throw voucherChanged();
          await checkIns.assertCheckIn(user.id, storeId, state.counterId, tx);
          assertConversionCart(state);
          const current = await customer(tx, state.customerId!),
            binding = await readCustomerContactBinding(tx, state.customerId!);
          if (
            !state.verificationChallenge ||
            !state.verifiedCustomerContact ||
            !state.verifiedCustomerUntil ||
            state.verifiedCustomerUntil <= clock() ||
            !sameCustomerContact(binding, state.verifiedCustomerContact)
          )
            throw new AppError(
              403,
              'CUSTOMER_VERIFICATION_REQUIRED',
              'Verify this customer before converting a voucher.',
            );
          await otp.assertVerified(
            tx,
            user,
            {
              operatorId: user.id,
              storeId,
              counterId: state.counterId,
              customerId: state.customerId!,
              purpose: 'checkout-benefits',
              subjectId: checkoutId,
              orderId: null,
            },
            state.verificationChallenge.id,
            binding,
            state.verifiedCustomerUntil,
          );
          const [preview] = await tx
            .select({ id: globalVouchers.id, collectionId: globalVouchers.collectionId })
            .from(globalVouchers)
            .where(eq(globalVouchers.code, input.voucherCode))
            .limit(1);
          if (!preview) throw new AppError(404, 'VOUCHER_NOT_FOUND', 'Voucher Does Not Exist');
          if (preview.collectionId > 0n) {
            const [collection] = await tx
              .select({ id: GiftCardCollection.id })
              .from(GiftCardCollection)
              .where(eq(GiftCardCollection.id, preview.collectionId))
              .limit(1)
              .for('update');
            if (!collection) throw voucherIntegrity();
          }
          const [voucher] = await tx
            .select({
              voucher: globalVouchers,
              fundingHash: sql<string>`${sql.raw(giftCardIssuanceHashSql)}`,
            })
            .from(globalVouchers)
            .where(eq(globalVouchers.id, preview.id))
            .limit(1)
            .for('update');
          if (
            !voucher ||
            voucher.voucher.collectionId !== preview.collectionId ||
            voucher.voucher.code.toLowerCase() !== input.voucherCode.toLowerCase()
          )
            throw voucherChanged();
          const card = voucher.voucher,
            now = wall();
          if (
            !['GIFT_VOUCHER', 'GIFT_CARD'].includes(card.kind) ||
            !['online', 'both'].includes(card.platform)
          )
            throw new AppError(
              422,
              'VOUCHER_PLATFORM_UNSUPPORTED',
              'Voucher Not Valid For Online Use',
            );
          if (card.status !== 1)
            throw new AppError(422, 'VOUCHER_DEACTIVATED', 'This voucher code is deactivated.');
          if (card.recipient && card.recipient !== current.email)
            throw new AppError(
              403,
              'VOUCHER_RECIPIENT_MISMATCH',
              'This voucher is not valid for this user',
            );
          if (card.kind === 'GIFT_CARD') {
            if (
              options.GLOBAL_VOUCHER_GIFT_CARD_DATES_ENABLED &&
              !giftCardDatesValid(card.startsAt, card.expiresAt, now)
            )
              throw new AppError(422, 'GIFT_CARD_EXPIRED', 'Gift card expired.');
            const [funding] = await tx
              .select()
              .from(giftCardIssuances)
              .where(eq(giftCardIssuances.voucherId, card.id))
              .limit(1)
              .for('share');
            if (
              !funding ||
              funding.contract !== giftCardIssuanceContract ||
              funding.orderId !== card.orderId ||
              funding.collectionId !== card.collectionId ||
              funding.serial !== card.serial ||
              funding.inputHash !== voucher.fundingHash
            )
              throw new AppError(
                409,
                'GIFT_CARD_FUNDING_UNCONFIRMED',
                'Gift card funding requires verified issuance evidence.',
              );
          }
          const planned = planVoucherConversion(
              card.value,
              card.initialValue,
              current.money,
              current.cashback,
            ),
            badPin = await pin(tx, card, input.giftCardPin);
          if (badPin) {
            await tx
              .update(voucherOperations)
              .set({ errorCode: badPin })
              .where(eq(voucherOperations.id, input.operationId));
            return { error: badPin, receipt: null };
          }
          await tx
            .update(globalVouchers)
            .set({ value: 0, status: card.kind === 'GIFT_CARD' ? 0 : card.status, updatedAt: now })
            .where(eq(globalVouchers.id, card.id));
          const amount = Number(voucherAmountString(planned.amount));
          const voucherHistoryId = generatedId(
            await tx.insert(globalVoucherHistory).values({
              userId: current.id,
              orderId: 0n,
              voucherId: card.id,
              amount: -amount,
              before: amount,
              after: 0,
              platform: 'MISC_COMPENSATION',
              comment: 'Voucher Converted To TSS Money',
              operatorId: BigInt(user.id),
              createdAt: now,
              updatedAt: now,
              bulk: 0,
            }),
          );
          const moneyHistoryId = generatedId(
            await tx.insert(walletMoneyHistory).values({
              userId: current.id,
              orderId: 0n,
              productId: 0n,
              addedAmount: amount,
              usedAmount: 0,
              balanceBefore: Number(voucherAmountString(planned.before)),
              balanceAfter: planned.numeric,
              platform: 'MISC_COMPENSATION',
              comment: 'Voucher Converted To TSS Money',
              addedUser: BigInt(user.id),
              createdAt: now,
              updatedAt: now,
              expiry:
                !options.GLOBAL_VOUCHER_MONEY_EXPIRY_ENABLED ||
                card.expiresAt === '0000-00-00 00:00:00'
                  ? null
                  : card.expiresAt,
              expired: 0,
            }),
          );
          await tx
            .update(MUser)
            .set({ tss_money: planned.numeric, updated_at: now })
            .where(eq(MUser.id, current.id));
          const [stored] = await tx
            .select(customerProjection)
            .from(MUser)
            .where(eq(MUser.id, current.id))
            .limit(1);
          if (
            !stored ||
            stored.cashback !== current.cashback ||
            storedVoucherMinorUnits(stored.money) !== planned.after
          )
            throw voucherIntegrity();
          const next = {
            ...state,
            phase: 'open' as const,
            quote: null,
            version: state.version + 1,
            updatedAt: clock(),
          };
          await tx
            .update(checkoutSessions)
            .set({ state: next, version: next.version })
            .where(eq(checkoutSessions.id, checkoutId));
          await audit(tx, user, String(current.id), 'conversion', input.operationId, now);
          const receipt = await save(tx, command.row, {
            operationId: input.operationId,
            kind: 'conversion',
            operatorId: user.id,
            customerId: String(current.id),
            voucherId: String(card.id),
            couponId: String(card.couponId),
            voucherCode: card.code,
            amount: voucherAmountString(planned.amount),
            voucherHistoryId: String(voucherHistoryId),
            moneyHistoryId: String(moneyHistoryId),
            walletBefore: voucherAmountString(planned.before),
            walletAfter: voucherAmountString(planned.after),
            nonExpiring: card.expiresAt === null || card.expiresAt === '0000-00-00 00:00:00',
            createdAt: now,
            contract: globalVoucherContract,
            valueContract: exactVoucherValueContract,
            checkoutId,
            checkoutVersion: next.version,
            status: 'success',
            message: 'voucher has been converted to tss money',
          });
          return { error: null, receipt };
        }),
      );
      if (outcome.error) throw voucherPinError(outcome.error);
      return outcome.receipt!;
    },
  };
}
