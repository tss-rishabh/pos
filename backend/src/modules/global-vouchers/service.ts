import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { generatedId } from '../../db/generated-id.js';
import { MUser, PosSpecialPermissionActivityLog } from '../../db/legacy-schema.js';
import { legacyZeroDateTime, storedEnumValue } from '../../db/legacy-columns.js';
import { voucherHistoryPlatforms } from '../../db/legacy-enums.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { JobProducer } from '../../jobs/contract.js';
import {
  assertCurrentOperatorRole,
  assertCurrentStoreAccess,
} from '../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import { activeCheckoutCustomer } from '../checkout/customer-access.js';
import type { CheckoutState } from '../checkout/contracts.js';
import { issueCustomerToken } from '../checkout/crypto.js';
import { checkoutEnvironment } from '../checkout/gateway.js';
import { checkoutSessionStore, type CheckoutSessionStore } from '../checkout/session-store.js';
import { configuredStateStore, readJson, type PosStateStore } from '../checkout/state-store.js';
import { assertConversionCart, authorizeVoucherIssuer } from './authorization.js';
import {
  voucherCancellationSchema,
  voucherCheckResultSchema,
  voucherCheckSchema,
  voucherConversionResultSchema,
  voucherConversionSchema,
  voucherIssuanceSchema,
  voucherLookupSchema,
  voucherReceiptSchema,
  voucherSelectionSchema,
  type VoucherCancellation,
  type VoucherCheck,
  type VoucherConversion,
  type VoucherConversionResult,
  type VoucherIssuance,
  type VoucherReceipt,
} from './contracts.js';
import {
  voucherChanged,
  voucherConflict,
  voucherMissing,
  voucherToMoneyDisabled,
  voucherUnconfirmed,
} from './errors.js';
import { globalCoupons, globalVoucherHistory, globalVouchers } from './legacy-schema.js';
import type { GlobalVoucherOptions } from './options.js';
import { voucherAmountString, voucherMinorUnits } from './policy.js';
import {
  apiV2VoucherUpstream,
  voucherServiceUncertain,
  type VoucherUpstream,
  type VoucherUpstreamPayload,
  type VoucherUpstreamReply,
} from './upstream.js';

export interface GlobalVoucherDependencies {
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  jobs?: JobProducer;
  upstream?: VoucherUpstream;
  /** Kept for the registration call; conversion no longer runs a native OTP-bound ledger. */
  customerOtp?: unknown;
  /** Defaults to the administration check-in service. */
  assertCheckIn?: (userId: string, storeId: string, counterId?: string) => Promise<void>;
  /** Checkout JWT keys for the customer Authorization header (defaults to checkoutEnvironment()). */
  tokenKeys?: { hs256?: string; hs512?: string };
}
/**
 * Redis (table-disposition.md "global-vouchers"):
 * - `pos:voucher_selection:{selectionId}`: {operatorId, customerId, email, name, expiresAt,
 *   consumedBy}, EX 300 s (replaces pos_rewrite_voucher_selections).
 * - `pos:voucher_op:{operationId}`: {operatorId, customerId, kind, requestHash, storeId,
 *   checkoutId, status, result}, SET NX EX 86400 (replaces pos_rewrite_voucher_operations).
 * Gift-card PIN attempts are counted by API-v2 under its `GC_PIN_LIMIT_{voucher_code}` key
 * (replaces pos_rewrite_voucher_pin_budgets): the POS forwards the PIN and never checks it.
 */
export const voucherKeys = {
  selection: (id: string) => `pos:voucher_selection:${id}`,
  operation: (id: string) => `pos:voucher_op:${id}`,
};
const SELECTION_TTL_MS = 300_000,
  OPERATION_TTL_SECONDS = 86400;
const selectionRecordSchema = z
  .object({
    operatorId: identifier,
    customerId: identifier,
    email: z.string().max(96),
    name: z.string().max(130),
    expiresAt: z.number().int(),
    consumedBy: z.uuid().nullable(),
  })
  .strict();
const operationRecordSchema = z
  .object({
    operatorId: identifier,
    customerId: identifier,
    kind: z.enum(['issuance', 'conversion']),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    storeId: identifier.nullable(),
    checkoutId: z.uuid().nullable(),
    status: z.enum(['inflight', 'succeeded', 'uncertain', 'cancelled']),
    result: z.union([voucherReceiptSchema, voucherConversionResultSchema]).nullable(),
  })
  .strict();
type OperationRecord = z.infer<typeof operationRecordSchema>;
const customerProjection = {
  id: MUser.id,
  email: MUser.email,
  firstName: MUser.firstname,
  lastName: MUser.lastname,
  telephone: MUser.telephone,
  twoFactor: MUser.is_two_fa,
  active: MUser.status,
  blocked: MUser.is_block,
  disabled: MUser.is_disabled,
};
const upstreamError = z
  .object({
    title: z.union([
      z.string(),
      z
        .object({
          title: z.string().optional(),
          is_pin_required: z.unknown().optional(),
          is_pin_valid: z.unknown().optional(),
        })
        .passthrough(),
    ]),
  })
  .passthrough();
/**
 * Maps the upstream reply the legacy page branches on (create_order.html:3786-4060):
 * 200 -> success; 400 + `title.is_pin_required` -> PIN dialog / "invalid PIN" (`title.title`);
 * 401 -> `message`; anything else -> `message.title`.
 */
function rejection(reply: VoucherUpstreamReply, pinSupplied: boolean): AppError {
  const parsed = upstreamError.safeParse(reply.body);
  if (reply.status === 400 && parsed.success && typeof parsed.data.title === 'object') {
    const title = parsed.data.title;
    if (title.is_pin_required && (!pinSupplied || !title.is_pin_valid))
      return pinSupplied
        ? new AppError(422, 'GIFT_CARD_PIN_INVALID', title.title || 'Invalid PIN')
        : new AppError(
            422,
            'GIFT_CARD_PIN_REQUIRED',
            title.title || 'Please Enter the GIFT CARD PIN',
          );
    return new AppError(422, 'VOUCHER_REJECTED', title.title || 'This voucher cannot be used.');
  }
  if (reply.status >= 500) return voucherServiceUncertain();
  const message =
    parsed.success && typeof parsed.data.title === 'string'
      ? parsed.data.title
      : z.object({ message: z.string() }).passthrough().safeParse(reply.body).data?.message;
  return new AppError(
    reply.status === 401 ? 502 : 422,
    reply.status === 401 ? 'VOUCHER_SERVICE_UNAUTHORIZED' : 'VOUCHER_REJECTED',
    (message || 'This voucher cannot be used.').slice(0, 300),
  );
}
const hashOf = (kind: string, value: unknown) =>
  createHash('sha256')
    .update(kind + '\0' + JSON.stringify(value))
    .digest('hex');

export function globalVoucherService(
  config: Config,
  db: Databases,
  _options: GlobalVoucherOptions = {},
  dependencies: GlobalVoucherDependencies = {},
  clock: () => number = Date.now,
  createCode: () => string = () => 'GFV' + randomBytes(11).toString('hex').toUpperCase(),
) {
  const checkIns = checkInService(db, config),
    assertCheckIn =
      dependencies.assertCheckIn ||
      ((userId: string, storeId: string, counterId?: string) =>
        checkIns.assertCheckIn(userId, storeId, counterId)),
    store = dependencies.stateStore || dependencies.sessions?.store || configuredStateStore(config),
    sessions = dependencies.sessions || checkoutSessionStore(store),
    upstream = dependencies.upstream || apiV2VoucherUpstream(config);
  function wall() {
    return Temporal.Instant.fromEpochMilliseconds(clock())
      .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  }
  /** `ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT` (settings.py:622, int(env, 0)). */
  const voucherToMoney = () => config.ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT !== 0;
  async function lockedCustomer(tx: AdministrationTransaction, id: string) {
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
  const readOperation = (id: string) =>
    readJson(store, voucherKeys.operation(id), operationRecordSchema);
  async function claim(id: string, record: OperationRecord) {
    const serialized = JSON.stringify(record);
    if (await store.set(voucherKeys.operation(id), serialized, OPERATION_TTL_SECONDS, true))
      return { fresh: true as const, serialized, existing: null };
    const existing = await readOperation(id);
    if (
      !existing ||
      existing.operatorId !== record.operatorId ||
      existing.customerId !== record.customerId ||
      existing.kind !== record.kind ||
      existing.requestHash !== record.requestHash ||
      existing.storeId !== record.storeId ||
      existing.checkoutId !== record.checkoutId
    )
      throw voucherConflict();
    return { fresh: false as const, serialized, existing };
  }
  function settled(record: OperationRecord) {
    if (record.status === 'cancelled') throw voucherMissing();
    if (record.status !== 'succeeded' || !record.result) throw voucherUnconfirmed();
    return record.result;
  }
  async function finish(id: string, record: OperationRecord) {
    await store.set(voucherKeys.operation(id), JSON.stringify(record), OPERATION_TTL_SECONDS);
  }
  /** The sale must belong to this operator, be editable and carry a verified customer. */
  async function conversionContext(user: Principal, storeId: string, checkoutId: string) {
    identifier.parse(storeId);
    z.uuid().parse(checkoutId);
    requireStore(user, storeId);
    if (!voucherToMoney()) throw voucherToMoneyDisabled();
    const state = await sessions.readScoped(user.id, storeId, checkoutId);
    if (!state || !state.customerId) throw voucherChanged();
    await assertCheckIn(user.id, storeId, state.counterId);
    // create_order.html:293: the input is enabled only for `user_obj and is_verified`.
    if (!state.verifiedCustomerUntil || state.verifiedCustomerUntil <= clock())
      throw new AppError(
        403,
        'CUSTOMER_VERIFICATION_REQUIRED',
        'Verify this customer before checking or converting a voucher.',
      );
    if (!['open', 'quoted'].includes(state.phase) || state.orderId || state.busyOperationId)
      throw voucherChanged();
    const [customer] = await db
      .get('writer')
      .select(customerProjection)
      .from(MUser)
      .where(eq(MUser.id, BigInt(state.customerId)))
      .limit(1);
    if (!customer || !activeCheckoutCustomer(customer))
      throw new AppError(
        409,
        'VOUCHER_CUSTOMER_UNAVAILABLE',
        'A unique active customer is required.',
      );
    const keys = dependencies.tokenKeys || checkoutEnvironment();
    const authorization = issueCustomerToken(
      {
        id: String(customer.id),
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        telephone: customer.telephone,
        twoFactor: customer.twoFactor === 1,
        exclusive: false,
        active: true,
      },
      keys,
      clock(),
    );
    return { state, customer, authorization };
  }
  const payload = (
    customer: { id: bigint; email: string },
    code: string,
    pin: string | undefined,
  ): VoucherUpstreamPayload => ({
    user_id: String(customer.id),
    gift_voucher_code: code,
    gc_pin: pin ?? '0',
    user_email: customer.email,
  });
  return {
    async capabilities(user: Principal) {
      return db.get('writer').transaction(async (tx) => {
        await authorizeVoucherIssuer(tx, user);
        return { enabled: true as const };
      });
    },
    async conversionCapabilities(user: Principal, storeId: string, checkoutId: string) {
      identifier.parse(storeId);
      z.uuid().parse(checkoutId);
      requireStore(user, storeId);
      return { enabled: voucherToMoney() };
    },
    /** AjaxGiftVoucherModuleView resolves `MUser.objects.filter(email=...)` (core/views.py:1493). */
    async lookup(user: Principal, supplied: { email: string }) {
      const input = voucherLookupSchema.parse(supplied);
      const current = await db.get('writer').transaction(async (tx) => {
        await authorizeVoucherIssuer(tx, user);
        const candidates = await tx
          .select({ id: MUser.id })
          .from(MUser)
          .where(eq(MUser.email, input.email))
          .orderBy(asc(MUser.id))
          .limit(2);
        if (!candidates.length)
          throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'User Does not exists');
        if (candidates.length !== 1)
          throw new AppError(
            409,
            'CUSTOMER_IDENTITY_UNCONFIRMED',
            'A unique current customer is required.',
          );
        return lockedCustomer(tx, String(candidates[0]!.id));
      });
      const selectionId = randomUUID(),
        expiresAt = clock() + SELECTION_TTL_MS,
        name = `${current.firstName} ${current.lastName}`;
      await store.set(
        voucherKeys.selection(selectionId),
        JSON.stringify(
          selectionRecordSchema.parse({
            operatorId: user.id,
            customerId: String(current.id),
            email: current.email,
            name: name.slice(0, 130),
            expiresAt,
            consumedBy: null,
          }),
        ),
        SELECTION_TTL_MS / 1000,
      );
      return voucherSelectionSchema.parse({
        selectionId,
        customerId: String(current.id),
        name: name.slice(0, 130),
        expiresAt,
      });
    },
    async get(user: Principal, id: string) {
      z.uuid().parse(id);
      const record = await readOperation(id);
      if (!record || record.operatorId !== user.id) throw voucherMissing();
      await db.get('writer').transaction(async (tx) => {
        await assertCurrentOperatorRole(tx, user.id, [1, 2, 3, 4, 5]);
        if (record.kind === 'issuance') await authorizeVoucherIssuer(tx, user);
        else {
          if (!record.storeId) throw voucherUnconfirmed();
          requireStore(user, record.storeId);
          await assertCurrentStoreAccess(tx, user.id, record.storeId);
        }
      });
      if (record.status === 'cancelled') return { status: 'cancelled' as const, receipt: null };
      return { status: 'succeeded' as const, receipt: settled(record) };
    },
    /** Fences an operation ID the browser abandoned: it can never execute afterwards. */
    async cancel(user: Principal, operationId: string, supplied: VoucherCancellation) {
      z.uuid().parse(operationId);
      const input = voucherCancellationSchema.parse(supplied);
      let customerId: string;
      if (input.kind === 'issuance') {
        await db.get('writer').transaction((tx) => authorizeVoucherIssuer(tx, user));
        const selection = await readJson(
          store,
          voucherKeys.selection(input.selectionId),
          selectionRecordSchema,
        );
        const existing = await readOperation(operationId);
        if (existing && existing.operatorId === user.id && existing.kind === 'issuance')
          customerId = existing.customerId;
        else if (selection && selection.operatorId === user.id) customerId = selection.customerId;
        else throw voucherChanged();
      } else {
        requireStore(user, input.storeId);
        await db
          .get('writer')
          .transaction((tx) => assertCurrentStoreAccess(tx, user.id, input.storeId));
        const state = await sessions.readScoped(user.id, input.storeId, input.checkoutId);
        if (!state?.customerId) throw voucherChanged();
        customerId = state.customerId;
      }
      const fence: OperationRecord = {
        operatorId: user.id,
        customerId,
        kind: input.kind,
        requestHash: hashOf('cancelled', operationId),
        storeId: input.kind === 'conversion' ? input.storeId : null,
        checkoutId: input.kind === 'conversion' ? input.checkoutId : null,
        status: 'cancelled',
        result: null,
      };
      if (
        await store.set(
          voucherKeys.operation(operationId),
          JSON.stringify(fence),
          OPERATION_TTL_SECONDS,
          true,
        )
      )
        return { status: 'cancelled' as const, receipt: null };
      const existing = await readOperation(operationId);
      if (!existing || existing.operatorId !== user.id || existing.kind !== input.kind)
        throw voucherConflict();
      if (existing.status === 'cancelled') return { status: 'cancelled' as const, receipt: null };
      return { status: 'succeeded' as const, receipt: settled(existing) };
    },
    /** AjaxGiftVoucherModuleView (core/views.py:1482-1555); W7 production-schema values. */
    async issue(user: Principal, supplied: VoucherIssuance): Promise<VoucherReceipt> {
      const input = voucherIssuanceSchema.parse(supplied),
        minor = voucherMinorUnits(input.amount);
      await db.get('writer').transaction((tx) => authorizeVoucherIssuer(tx, user));
      const selectionKey = voucherKeys.selection(input.selectionId),
        rawSelection = await store.get(selectionKey),
        selection = await readJson(store, selectionKey, selectionRecordSchema);
      const existing = await readOperation(input.operationId);
      if (existing) {
        if (
          existing.operatorId !== user.id ||
          existing.kind !== 'issuance' ||
          existing.requestHash !== hashOf('issuance', input)
        )
          throw voucherConflict();
        return voucherReceiptSchema.parse(settled(existing));
      }
      if (!selection || !rawSelection || selection.operatorId !== user.id) throw voucherChanged();
      const record: OperationRecord = {
        operatorId: user.id,
        customerId: selection.customerId,
        kind: 'issuance',
        requestHash: hashOf('issuance', input),
        storeId: null,
        checkoutId: null,
        status: 'inflight',
        result: null,
      };
      const claimed = await claim(input.operationId, record);
      if (!claimed.fresh) return voucherReceiptSchema.parse(settled(claimed.existing));
      const consumed = JSON.stringify({ ...selection, consumedBy: input.operationId });
      if (
        selection.expiresAt <= clock() ||
        selection.consumedBy !== null ||
        !(await store.compareAndSet(selectionKey, rawSelection, consumed, SELECTION_TTL_MS / 1000))
      ) {
        await store.deleteIfEquals(voucherKeys.operation(input.operationId), claimed.serialized);
        throw voucherChanged();
      }
      let receipt: VoucherReceipt,
        bodyCompleted = false;
      try {
        receipt = await retryTransaction(() =>
          db.get('writer').transaction(async (tx) => {
            bodyCompleted = false;
            await authorizeVoucherIssuer(tx, user);
            const current = await lockedCustomer(tx, selection.customerId);
            if (current.email !== selection.email) throw voucherChanged();
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
                // Legacy omits end_date; NOT NULL without default stores the zero date under the
                // production sql_mode.
                expiresAt: legacyZeroDateTime,
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
                // Legacy INSERT ... SELECT omits both dates (zero date, see above).
                startsAt: legacyZeroDateTime,
                expiresAt: legacyZeroDateTime,
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
                // Legacy writes 'GV_ADD', which is not an ENUM member and is stored as ''.
                platform: storedEnumValue(voucherHistoryPlatforms, 'GV_ADD'),
                // Legacy added_user '0' (core/views.py:1544-1545).
                operatorId: 0n,
                createdAt: now,
                updatedAt: now,
                bulk: 0,
              }),
            );
            const message = `Gift Voucher ${code} Has been created for ${current.email} and amount is ${input.amount}`;
            // helpers/helpers.py:740-756, platform "Gift Voucher", recipient = email.
            await tx.insert(PosSpecialPermissionActivityLog).values({
              pos_user_id: BigInt(user.id),
              platform: 'Gift Voucher',
              recipient: current.email,
              comment: message,
              created_at: now,
              updated_at: now,
            });
            const issued = voucherReceiptSchema.parse({
              operationId: input.operationId,
              kind: 'issuance',
              operatorId: user.id,
              customerId: String(current.id),
              voucherId: String(voucherId),
              couponId: String(couponId),
              voucherCode: code,
              amount,
              voucherHistoryId: String(historyId),
              nonExpiring: true,
              createdAt: now,
              status: 'success',
              message,
            });
            bodyCompleted = true;
            return issued;
          }),
        );
      } catch (error) {
        // A body failure rolled back; a COMMIT failure may have committed and stays frozen.
        if (!bodyCompleted || (error instanceof AppError && error.status < 500)) {
          await store.deleteIfEquals(voucherKeys.operation(input.operationId), claimed.serialized);
          await store.compareAndSet(selectionKey, consumed, rawSelection, SELECTION_TTL_MS / 1000);
        } else await finish(input.operationId, { ...record, status: 'uncertain' });
        throw error;
      }
      await finish(input.operationId, { ...record, status: 'succeeded', result: receipt });
      return receipt;
    },
    /** AjaxGiftVoucherCheck (order/views.py:4518-4546) -> API-v2 `gift_voucher_check`. */
    async check(user: Principal, storeId: string, checkoutId: string, supplied: VoucherCheck) {
      const input = voucherCheckSchema.parse(supplied),
        context = await conversionContext(user, storeId, checkoutId);
      const reply = await upstream.call(
        'gift_voucher_check',
        payload(context.customer, input.voucherCode, input.giftCardPin),
        context.authorization,
      );
      if (reply.status !== 200) throw rejection(reply, Boolean(input.giftCardPin));
      const body = z
        .object({
          voucher_value: z.union([z.number(), z.string()]),
          voucher_validity: z.string().nullable().optional(),
        })
        .passthrough()
        .safeParse(reply.body);
      if (!body.success) throw voucherServiceUncertain();
      const validity = body.data.voucher_validity?.split(' ')[0] ?? null;
      return voucherCheckResultSchema.parse({
        voucherCode: input.voucherCode,
        voucherValue: String(body.data.voucher_value),
        validity,
        nonExpiring: validity === null || validity === '0000-00-00',
        pinUsed: Boolean(input.giftCardPin),
      });
    },
    /**
     * AjaxGiftVoucherConvert (order/views.py:4548-4579) -> API-v2 `gift_voucher_to_tss_money`.
     * API-v2 is the only writer of the voucher, history and TSS Money rows; the legacy page then
     * reloads the sale, so the saved quote is invalidated here.
     */
    async convert(
      user: Principal,
      storeId: string,
      checkoutId: string,
      supplied: VoucherConversion,
    ): Promise<VoucherConversionResult> {
      const input = voucherConversionSchema.parse(supplied),
        context = await conversionContext(user, storeId, checkoutId);
      assertConversionCart(context.state);
      const record: OperationRecord = {
        operatorId: user.id,
        customerId: context.state.customerId!,
        kind: 'conversion',
        requestHash: hashOf('conversion', [storeId, checkoutId, input]),
        storeId,
        checkoutId,
        status: 'inflight',
        result: null,
      };
      const claimed = await claim(input.operationId, record);
      if (!claimed.fresh) return voucherConversionResultSchema.parse(settled(claimed.existing));
      let reply: VoucherUpstreamReply;
      try {
        reply = await upstream.call(
          'gift_voucher_to_tss_money',
          payload(context.customer, input.voucherCode, input.giftCardPin),
          context.authorization,
        );
      } catch (error) {
        // An unknown outcome is never resent automatically.
        await finish(input.operationId, { ...record, status: 'uncertain' }).catch(() => undefined);
        throw error;
      }
      if (reply.status !== 200) {
        const error = rejection(reply, Boolean(input.giftCardPin));
        if (error.status >= 500)
          await finish(input.operationId, { ...record, status: 'uncertain' });
        else
          await store.deleteIfEquals(voucherKeys.operation(input.operationId), claimed.serialized);
        throw error;
      }
      // Legacy PIN path requires `message.status` (create_order.html:4026); 200 alone otherwise.
      if (
        input.giftCardPin &&
        !z.object({ status: z.unknown() }).passthrough().safeParse(reply.body).data?.status
      ) {
        await store.deleteIfEquals(voucherKeys.operation(input.operationId), claimed.serialized);
        throw rejection({ status: 422, body: reply.body }, true);
      }
      const result = voucherConversionResultSchema.parse({
        operationId: input.operationId,
        kind: 'conversion',
        operatorId: user.id,
        customerId: context.state.customerId!,
        storeId,
        checkoutId,
        voucherCode: input.voucherCode,
        pinUsed: Boolean(input.giftCardPin),
        status: 'success',
        message: input.giftCardPin
          ? "Gift Card Amount Has Been Transfered To User's TSS Money"
          : "Gift Voucher Amount Has Been Transfered To User's TSS Money",
      });
      await finish(input.operationId, { ...record, status: 'succeeded', result });
      await invalidateQuote(user, storeId, checkoutId).catch(() => undefined);
      return result;
    },
  };
  /** Equivalent of the legacy `location.reload()`: the TSS Money balance changed upstream. */
  async function invalidateQuote(user: Principal, storeId: string, checkoutId: string) {
    await sessions.exclusive(user.id, storeId, checkoutId, async (state: CheckoutState) => {
      if (state.phase !== 'quoted' || state.busyOperationId) return { state: null, value: null };
      return {
        state: {
          ...state,
          phase: 'open',
          quote: null,
          version: state.version + 1,
          updatedAt: clock(),
        },
        value: null,
      };
    });
  }
}
