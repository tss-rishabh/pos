import { Decimal } from 'decimal.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { Order, OrderStore, PosUser, Store } from '../../../db/legacy-schema.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { JobProducer } from '../../../jobs/contract.js';
import type { CheckoutState } from '../contracts.js';
import { checkoutSessionStore, type CheckoutSessionStore } from '../session-store.js';
import {
  configuredStateStore,
  readJson,
  withStateLock,
  type PosStateStore,
} from '../state-store.js';
import { approvalCode, codeDigest, matchesCode } from './crypto.js';
import {
  discountApprovalLimitSchema,
  discountChallengeSchema,
  discountOtpMapSchema,
  type DiscountApprovalEvidence,
  type DiscountApprovalLimit,
  type DiscountApprovals,
  type DiscountApprovalView,
  type DiscountChallenge,
} from './contracts.js';
import { escapeHtml, netcoreDiscountMailer, type DiscountMailer } from './delivery.js';
import {
  approverSelection,
  assertDiscountApplyPermission,
  discountTerms,
  type DiscountPolicy,
  type DiscountTerms,
} from './policy.js';
import { legacyDiscountAddons } from './schema.js';

export interface DiscountApprovalOptions {
  signingSecret: string;
  approvalSecret?: string;
  policy: DiscountPolicy;
  /** Optional readiness check run before codes are generated (kept for the registration call). */
  assertDeliveryReady?(): void;
  mailer?: DiscountMailer;
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  jobs?: JobProducer;
  now?: () => number;
}
/**
 * Redis keys (table-disposition.md "checkout/discounts"):
 * - `{uid}_{store}_{counter}_{tab}` (legacy key, order/views.py:4600): `{hmac: [managerId, amount]}`,
 *   EX PG_DISC_OTP_EX_VALUE.
 * - `pos:discount_approval:{checkoutId}`: DiscountChallenge JSON, same TTL.
 * - `pos:discount_approval_limit:{operatorId}`: `{lastSentAt, windowStartedAt, attempts}`, EX 600.
 * - `pos:discount_approval_lock:{operatorId}`: lock token (serialises one operator's approvals).
 * - `pos:discount_audit:{orderId}`: "1", EX 30 days (one addon row per order).
 */
export const discountKeys = {
  otp: (state: Pick<CheckoutState, 'operatorId' | 'storeId' | 'counterId' | 'tabId'>) =>
    `${state.operatorId}_${state.storeId}_${state.counterId}_${state.tabId}`,
  challenge: (checkoutId: string) => `pos:discount_approval:${checkoutId}`,
  limit: (operatorId: string) => `pos:discount_approval_limit:${operatorId}`,
  lock: (operatorId: string) => `pos:discount_approval_lock:${operatorId}`,
  audit: (orderId: string) => `pos:discount_audit:${orderId}`,
};
const LIMIT_WINDOW_MS = 600_000,
  RESEND_MS = 60_000,
  MAX_ATTEMPTS = 5,
  AUDIT_TTL_SECONDS = 30 * 24 * 3600;
const legacyInt = (value: string) => {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > 2147483647)
    throw new AppError(
      422,
      'DISCOUNT_AUDIT_REFERENCE_UNSUPPORTED',
      'This account or counter cannot be represented in the discount audit.',
    );
  return number;
};
/** Legacy renders `parseInt(pg) + parseInt(store)` (create_order.html) without decimals. */
const displayAmount = (amount: string) => new Decimal(amount).toString();
/** Python f-string of a NULL `first_name` renders "None" (core/tasks.py:254,261). */
const pyName = (value: string | null | undefined) => (value === null || value === undefined ? 'None' : value);

export function discountApprovals(
  db: Databases,
  config: Config,
  options: DiscountApprovalOptions,
): DiscountApprovals {
  const now = options.now || Date.now,
    policy = options.policy,
    store = options.stateStore || options.sessions?.store || configuredStateStore(config),
    sessions = options.sessions || checkoutSessionStore(store),
    mailer = options.mailer || netcoreDiscountMailer();
  const ttl = () => policy.expirySeconds;
  async function assertCurrent(state: CheckoutState) {
    const current = await sessions.read(state.id);
    if (
      !current ||
      current.operatorId !== state.operatorId ||
      current.storeId !== state.storeId ||
      current.busyOperationId !== state.busyOperationId ||
      current.version !== state.version
    )
      throw new AppError(
        409,
        'CHECKOUT_OPERATION_CHANGED',
        'Reload this checkout before continuing.',
      );
  }
  function requirement(user: Principal, state: CheckoutState) {
    const terms = discountTerms(state, options.signingSecret);
    if (terms.amount === '0.00')
      return { terms, required: false, selection: { emails: [], fallback: false, exempt: true } };
    legacyInt(state.operatorId);
    legacyInt(state.storeId);
    legacyInt(state.counterId);
    const selection = approverSelection(policy, state.storeId, terms);
    return {
      terms,
      // create_order.html:5061-5136: OTP only when the role is not in PG_DISC_OTP_EXEMPT and
      // AjaxPGDiscOTPSend did not answer 202 (no threshold list and SEND_OTP_TO_ALL_MANAGERS=0).
      required: !policy.exemptRoles.includes(user.role) && !selection.exempt,
      selection,
    };
  }
  /** core/tasks.py:235-240: active users by contact_email, else every active role-3 user. */
  async function managers(selection: ReturnType<typeof approverSelection>) {
    if (selection.exempt) return [];
    const rows = await db
      .get('writer')
      .select({ id: PosUser.id, email: PosUser.contact_email, name: PosUser.first_name })
      .from(PosUser)
      .where(
        and(
          eq(PosUser.is_active, true),
          selection.fallback
            ? eq(PosUser.role, 3)
            : inArray(PosUser.contact_email, selection.emails),
        ),
      )
      .orderBy(asc(PosUser.id))
      .limit(1001);
    if (rows.length > 1000)
      throw new AppError(
        503,
        'DISCOUNT_APPROVER_LIMIT',
        'Configure a smaller manager approval recipient list.',
      );
    return rows
      .filter((row) => row.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))
      .map((row) => {
        legacyInt(String(row.id));
        return { id: String(row.id), email: row.email!, name: row.name };
      });
  }
  const emptyView = (
    terms: DiscountTerms,
    status: DiscountApprovalView['status'],
  ): DiscountApprovalView => ({
    status,
    amount: terms.amount,
    productsTotal: terms.productsTotal,
    challengeId: null,
    expiresAt: null,
    retryAt: null,
    delivered: 0,
    pending: 0,
  });
  const readChallenge = async (checkoutId: string) =>
    readJson(store, discountKeys.challenge(checkoutId), discountChallengeSchema);
  async function readLimit(operatorId: string): Promise<DiscountApprovalLimit | null> {
    const limit = await readJson(store, discountKeys.limit(operatorId), discountApprovalLimitSchema);
    if (!limit || limit.windowStartedAt + LIMIT_WINDOW_MS <= now()) return null;
    return limit;
  }
  async function writeLimit(operatorId: string, limit: DiscountApprovalLimit) {
    const remaining = Math.max(1, Math.ceil((limit.windowStartedAt + LIMIT_WINDOW_MS - now()) / 1000));
    await store.set(discountKeys.limit(operatorId), JSON.stringify(limit), remaining);
  }
  async function saveChallenge(challenge: DiscountChallenge) {
    const remaining = Math.max(1, Math.ceil((challenge.expiresAt - now()) / 1000));
    await store.set(
      discountKeys.challenge(challenge.checkoutId),
      JSON.stringify(discountChallengeSchema.parse(challenge)),
      remaining,
    );
  }
  async function describe(user: Principal, state: CheckoutState): Promise<DiscountApprovalView> {
    const { terms, required } = requirement(user, state);
    if (!required) return emptyView(terms, 'not-required');
    const challenge = await readChallenge(state.id),
      budget = await readLimit(state.operatorId);
    const locked = Boolean(budget && budget.attempts >= MAX_ATTEMPTS);
    if (!challenge || challenge.binding !== terms.binding)
      return {
        ...emptyView(terms, locked ? 'locked' : 'required'),
        retryAt:
          Math.max(
            challenge ? challenge.lastSentAt + RESEND_MS : 0,
            budget ? budget.lastSentAt + RESEND_MS : 0,
            locked ? budget!.windowStartedAt + LIMIT_WINDOW_MS : 0,
          ) || null,
      };
    return {
      status:
        challenge.expiresAt <= now()
          ? 'expired'
          : challenge.approvedBy
            ? 'approved'
            : challenge.attempts >= MAX_ATTEMPTS || locked
              ? 'locked'
              : 'pending',
      amount: terms.amount,
      productsTotal: terms.productsTotal,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      retryAt: Math.max(
        challenge.lastSentAt + RESEND_MS,
        locked ? budget!.windowStartedAt + LIMIT_WINDOW_MS : 0,
      ),
      delivered: challenge.delivered,
      pending: 0,
    };
  }
  async function names(ids: string[]) {
    const rows = ids.length
      ? await db
          .get('writer')
          .select({ id: PosUser.id, name: PosUser.first_name, email: PosUser.contact_email })
          .from(PosUser)
          .where(inArray(PosUser.id, ids.map((id) => BigInt(id))))
      : [];
    return (id: string) => rows.find((row) => String(row.id) === id);
  }
  async function storeName(storeId: string) {
    const [row] = await db
      .get('writer')
      .select({ name: Store.store_name })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .limit(1);
    return row?.name ?? '';
  }
  return {
    permittedRoles: policy.permittedRoles,
    assertApplyPermission(user, kind, apply) {
      assertDiscountApplyPermission(policy, user, kind, apply);
    },
    describe,
    /** AjaxPGDiscOTPSend (order/views.py:4583-4628) + tasks.send_pg_disc_otp (core/tasks.py:232-266). */
    async request(user, state) {
      const { terms, required, selection } = requirement(user, state);
      if (!required) return emptyView(terms, 'not-required');
      await withStateLock(store, discountKeys.lock(state.operatorId), async () => {
        await assertCurrent(state);
        const existing = await readChallenge(state.id);
        // Legacy: while the OTP key exists, "otp already sent" and nothing is resent.
        if (
          existing &&
          existing.binding === terms.binding &&
          existing.expiresAt > now() &&
          existing.attempts < MAX_ATTEMPTS
        )
          return;
        const budget = await readLimit(state.operatorId);
        if (budget && budget.attempts >= MAX_ATTEMPTS)
          throw new AppError(
            429,
            'DISCOUNT_APPROVAL_ATTEMPT_LIMIT',
            'Wait before requesting another manager approval.',
          );
        if (
          (budget && budget.lastSentAt + RESEND_MS > now()) ||
          (existing && existing.lastSentAt + RESEND_MS > now())
        )
          throw new AppError(
            429,
            'DISCOUNT_APPROVAL_SEND_LIMIT',
            'Wait before requesting another manager code.',
          );
        options.assertDeliveryReady?.();
        if (!options.approvalSecret || options.approvalSecret.length < 32)
          throw new AppError(
            503,
            'DISCOUNT_APPROVAL_UNAVAILABLE',
            'Manager discount approval is not configured.',
          );
        const recipients = await managers(selection);
        if (!recipients.length)
          throw new AppError(
            503,
            'DISCOUNT_APPROVER_UNAVAILABLE',
            'No active manager has an approval delivery contact.',
          );
        const challengeId = crypto.randomUUID(),
          used = new Set<string>(),
          codes = new Map<string, string>(),
          otpMap: Record<string, [number, string]> = {};
        for (const manager of recipients) {
          let code = approvalCode();
          while (used.has(code)) code = approvalCode();
          used.add(code);
          codes.set(manager.id, code);
          otpMap[codeDigest(options.approvalSecret, challengeId, manager.id, code)] = [
            Number(manager.id),
            terms.amount,
          ];
        }
        const challenge: DiscountChallenge = {
          id: challengeId,
          checkoutId: state.id,
          otpKey: discountKeys.otp(state),
          binding: terms.binding,
          amount: terms.amount,
          productsTotal: terms.productsTotal,
          expiresAt: now() + ttl() * 1000,
          lastSentAt: now(),
          attempts: 0,
          delivered: 0,
          recipients: recipients.length,
          approvedBy: null,
          approvedAt: null,
        };
        await store.set(challenge.otpKey, JSON.stringify(otpMap), ttl());
        await saveChallenge(challenge);
        await writeLimit(state.operatorId, {
          lastSentAt: now(),
          windowStartedAt: budget?.windowStartedAt ?? now(),
          attempts: budget?.attempts ?? 0,
        });
        const [location, requester] = await Promise.all([
          storeName(state.storeId),
          names([state.operatorId]),
        ]);
        const requestedBy = escapeHtml(pyName(requester(state.operatorId)?.name));
        let delivered = 0;
        for (const manager of recipients) {
          const html = `Hello ${escapeHtml(pyName(manager.name))}, <br> <br>Your OTP for PG Discount - <b>${codes.get(manager.id)!}</b> <br> <br>Store - ${escapeHtml(location)} <br>Requested By - ${requestedBy} <br>PG Discount Value - ${displayAmount(terms.amount)} <br>Total Bill Amount Without GST - ${displayAmount(terms.productsTotal)} <br><i>This OTP is only valid for 10 min<i>`;
          if (await mailer.send({ to: manager.email, subject: 'PG Discount OTP Mail', html }))
            delivered++;
        }
        await saveChallenge({ ...challenge, delivered });
      });
      return describe(user, state);
    },
    /** AjaxPGDiscOTPCheck (order/views.py:4631-4660): the code and the PG value must both match. */
    async confirm(user, state, code) {
      const { terms, required, selection } = requirement(user, state);
      if (!required) return emptyView(terms, 'not-required');
      const error = await withStateLock(store, discountKeys.lock(state.operatorId), async () => {
        await assertCurrent(state);
        const challenge = await readChallenge(state.id);
        if (!challenge || challenge.binding !== terms.binding || challenge.expiresAt <= now())
          return 'DISCOUNT_APPROVAL_CHALLENGE_REQUIRED';
        if (challenge.approvedBy) return null;
        if (challenge.attempts >= MAX_ATTEMPTS) return 'DISCOUNT_APPROVAL_ATTEMPT_LIMIT';
        const budget = (await readLimit(state.operatorId)) || {
          lastSentAt: 0,
          windowStartedAt: now(),
          attempts: 0,
        };
        if (budget.attempts >= MAX_ATTEMPTS) return 'DISCOUNT_APPROVAL_ATTEMPT_LIMIT';
        if (!options.approvalSecret)
          throw new AppError(
            503,
            'DISCOUNT_APPROVAL_UNAVAILABLE',
            'Manager discount approval is not configured.',
          );
        const otpMap = await readJson(store, challenge.otpKey, discountOtpMapSchema);
        let matched: string | null = null;
        for (const [digest, [managerId, amount]] of Object.entries(otpMap || {}))
          if (
            amount === terms.amount &&
            matchesCode(options.approvalSecret, challenge.id, String(managerId), code, digest)
          )
            matched = String(managerId);
        if (matched && !(await managers(selection)).some((manager) => manager.id === matched))
          matched = null;
        await saveChallenge({
          ...challenge,
          attempts: challenge.attempts + 1,
          approvedBy: matched,
          approvedAt: matched ? now() : null,
        });
        await writeLimit(state.operatorId, { ...budget, attempts: budget.attempts + 1 });
        return matched ? null : 'DISCOUNT_APPROVAL_CODE_INVALID';
      });
      if (error)
        throw new AppError(
          error === 'DISCOUNT_APPROVAL_ATTEMPT_LIMIT' ? 429 : 422,
          error,
          error === 'DISCOUNT_APPROVAL_CODE_INVALID'
            ? 'The manager approval code is incorrect.'
            : error === 'DISCOUNT_APPROVAL_ATTEMPT_LIMIT'
              ? 'Wait before requesting another manager approval.'
              : 'Request a new manager approval code for this checkout.',
        );
      return describe(user, state);
    },
    /** AjaxOrderView reads the OTP key before `pos/order` (order/views.py:2709-2721). */
    async authorize(user, state) {
      const { terms, required, selection } = requirement(user, state);
      if (!required) return { terms, approvalId: null, approvedBy: null };
      await assertCurrent(state);
      const challenge = await readChallenge(state.id);
      if (
        !challenge ||
        challenge.binding !== terms.binding ||
        challenge.expiresAt <= now() ||
        !challenge.approvedBy ||
        !(await managers(selection)).some((manager) => manager.id === challenge.approvedBy)
      )
        throw new AppError(
          403,
          'DISCOUNT_APPROVAL_REQUIRED',
          'A manager must approve the current final quote before this order is created.',
        );
      return { terms, approvalId: challenge.id, approvedBy: challenge.approvedBy };
    },
    async record(state, orderId, evidence: DiscountApprovalEvidence) {
      const comment = evidence.terms.comment;
      // One addon row per order (legacy has no idempotency; the rewrite retries submissions).
      const first =
        comment.length > 1
          ? await store.set(discountKeys.audit(orderId), '1', AUDIT_TTL_SECONDS, true)
          : false;
      const ids = [state.operatorId, ...(evidence.approvedBy ? [evidence.approvedBy] : [])];
      const people = await names(ids);
      try {
        await db.get('writer').transaction(async (tx) => {
          const [order] = await tx
            .select({ customerId: Order.user })
            .from(OrderStore)
            .innerJoin(Order, eq(Order.id, OrderStore.order))
            .where(
              and(
                eq(Order.id, BigInt(orderId)),
                eq(OrderStore.store, BigInt(state.storeId)),
                eq(OrderStore.counter, BigInt(state.counterId)),
              ),
            )
            .for('update');
          if (!order || String(order.customerId) !== (state.customerId || state.operatorCustomerId))
            throw new AppError(
              409,
              'DISCOUNT_ORDER_SCOPE_MISMATCH',
              'The discount order could not be verified.',
            );
          // order/views.py:2764-2767: written for every order.
          await tx
            .update(Order)
            .set({
              store_disc_pg_comment: evidence.terms.storeComment,
              store_disc_pg_reason: evidence.terms.storeReason,
            })
            .where(eq(Order.id, BigInt(orderId)));
          if (!first) return;
          const name = (id: string) => people(id)?.name ?? null;
          await tx.insert(legacyDiscountAddons).values({
            orderId,
            // pg_disc_desc is VARCHAR(45); the production sql_mode stores the first 45 characters.
            description: Array.from(comment).slice(0, 45).join(''),
            amount: new Decimal(evidence.terms.amount).trunc().toNumber(),
            otp: null,
            providedBy: evidence.approvedBy ? legacyInt(evidence.approvedBy) : null,
            providedByName: evidence.approvedBy ? name(evidence.approvedBy) : null,
            appliedBy: legacyInt(state.operatorId),
            appliedByName: name(state.operatorId),
            storeId: legacyInt(state.storeId),
            counterId: legacyInt(state.counterId),
          });
        });
      } catch (error) {
        if (first) await store.del(discountKeys.audit(orderId)).catch(() => undefined);
        throw error;
      }
      if (!first) return;
      if (evidence.approvalId) {
        const challenge = await readChallenge(state.id).catch(() => null);
        await store.del(discountKeys.challenge(state.id), ...(challenge ? [challenge.otpKey] : []));
      }
      // core/tasks.py:286-322: approver (OTP path) or operator receives "PG Discount Used".
      const target = evidence.approvedBy || state.operatorId,
        recipient = people(target);
      if (!recipient?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email)) return;
      const location = escapeHtml(await storeName(state.storeId)),
        amount = displayAmount(new Decimal(evidence.terms.amount).trunc().toFixed(0));
      const html = evidence.approvedBy
        ? `Hello ${escapeHtml(pyName(recipient.name))}, <br> <br>Your PG Discount OTP has been applied <br> <br>Order ID - ${escapeHtml(orderId)} <br>PG Discount Comment - ${escapeHtml(comment)} <br>PG Discount Value - ${amount} <br>Applied By - ${escapeHtml(pyName(people(state.operatorId)?.name))} <br>Store Name - ${location}`
        : `Hello ${escapeHtml(pyName(recipient.name))}, <br> <br>PG Discount has been applied from your account<br> <br>Order ID - ${escapeHtml(orderId)} <br>PG Discount Comment - ${escapeHtml(comment)} <br>PG Discount Value - ${amount} <br>Store Name - ${location}`;
      await mailer.send({
        to: recipient.email,
        subject: `PG Discount Used For Order - ${orderId}`,
        html,
      });
    },
  };
}
