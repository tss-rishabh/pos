import { Decimal } from 'decimal.js';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { Order, OrderStore, PosUser } from '../../../db/legacy-schema.js';
import { requireRole, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import type { CheckoutState } from '../contracts.js';
import { checkoutSessions } from '../schema.js';
import { approvalCode, codeDigest, encryptCode, matchesCode } from './crypto.js';
import type {
  DiscountApprovalEvidence,
  DiscountApprovals,
  DiscountApprovalView,
  DiscountChallenge,
} from './contracts.js';
import {
  approverSelection,
  discountTerms,
  type DiscountPolicy,
  type DiscountTerms,
} from './policy.js';
import {
  discountAudits,
  discountApprovalLimits,
  discountChallenges,
  discountDeliveries,
  legacyDiscountAddons,
} from './schema.js';

export interface DiscountApprovalOptions {
  signingSecret: string;
  approvalSecret?: string;
  policy: DiscountPolicy;
  assertDeliveryReady(): void;
  now?: () => number;
}
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
export function discountApprovals(
  db: Databases,
  config: Config,
  options: DiscountApprovalOptions,
): DiscountApprovals {
  const now = options.now || Date.now,
    policy = options.policy;
  const date = () =>
    Temporal.Instant.fromEpochMilliseconds(now())
      .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const scope = (state: CheckoutState) =>
    and(
      eq(checkoutSessions.id, state.id),
      eq(checkoutSessions.operatorId, state.operatorId),
      eq(checkoutSessions.storeId, state.storeId),
    );
  async function lockSession(tx: AdministrationTransaction, state: CheckoutState) {
    const [row] = await tx
      .select({ state: checkoutSessions.state })
      .from(checkoutSessions)
      .where(scope(state))
      .for('update');
    if (
      !row ||
      row.state.busyOperationId !== state.busyOperationId ||
      row.state.version !== state.version
    )
      throw new AppError(
        409,
        'CHECKOUT_OPERATION_CHANGED',
        'Reload this checkout before continuing.',
      );
    await checkInService(db, config).assertCheckIn(
      state.operatorId,
      state.storeId,
      state.counterId,
      tx,
    );
  }
  function requirement(user: Principal, state: CheckoutState) {
    const terms = discountTerms(state, options.signingSecret);
    if (terms.amount === '0.00')
      return { terms, required: false, selection: { emails: [], fallback: false, exempt: true } };
    requireRole(user, policy.permittedRoles);
    legacyInt(state.operatorId);
    legacyInt(state.storeId);
    legacyInt(state.counterId);
    const selection = approverSelection(policy, state.storeId, terms);
    return {
      terms,
      required: !policy.exemptRoles.includes(user.role) && !selection.exempt,
      selection,
    };
  }
  async function managers(
    tx: AdministrationTransaction,
    selection: ReturnType<typeof approverSelection>,
  ) {
    if (selection.exempt) return [];
    const rows = await tx
      .select({ id: PosUser.id, email: PosUser.contact_email })
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
        return String(row.id);
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
  async function operatorLimit(tx: AdministrationTransaction, operatorId: string) {
    await tx
      .insert(discountApprovalLimits)
      .values({ operatorId, lastSentAt: 0, windowStartedAt: now(), attempts: 0 })
      .onDuplicateKeyUpdate({ set: { operatorId } });
    const [row] = await tx
      .select()
      .from(discountApprovalLimits)
      .where(eq(discountApprovalLimits.operatorId, operatorId))
      .for('update');
    if (!row) throw new Error('Approval limit unavailable');
    if (row.windowStartedAt + 600000 <= now()) {
      const next = { ...row, windowStartedAt: now(), attempts: 0 };
      await tx
        .update(discountApprovalLimits)
        .set(next)
        .where(eq(discountApprovalLimits.operatorId, operatorId));
      return next;
    }
    return row;
  }
  async function describe(user: Principal, state: CheckoutState): Promise<DiscountApprovalView> {
    const { terms, required } = requirement(user, state);
    if (!required) return emptyView(terms, 'not-required');
    const [row] = await db
        .get('writer')
        .select()
        .from(discountChallenges)
        .where(eq(discountChallenges.checkoutId, state.id))
        .limit(1),
      challenge = row?.state;
    const [budget] = await db
      .get('writer')
      .select()
      .from(discountApprovalLimits)
      .where(eq(discountApprovalLimits.operatorId, state.operatorId))
      .limit(1);
    const locked = Boolean(
      budget && budget.attempts >= 5 && budget.windowStartedAt + 600000 > now(),
    );
    if (!challenge || challenge.binding !== terms.binding)
      return {
        ...emptyView(terms, locked ? 'locked' : 'required'),
        retryAt:
          Math.max(
            challenge ? challenge.lastSentAt + 60000 : 0,
            budget ? budget.lastSentAt + 60000 : 0,
            locked ? budget!.windowStartedAt + 600000 : 0,
          ) || null,
      };
    const counts = await db
      .get('writer')
      .select({ status: discountDeliveries.status, total: count() })
      .from(discountDeliveries)
      .where(
        and(
          eq(discountDeliveries.checkoutId, state.id),
          eq(discountDeliveries.challengeId, challenge.id),
        ),
      )
      .groupBy(discountDeliveries.status);
    return {
      status:
        challenge.expiresAt <= now()
          ? 'expired'
          : challenge.approvedBy
            ? 'approved'
            : challenge.attempts >= 5 || locked
              ? 'locked'
              : 'pending',
      amount: terms.amount,
      productsTotal: terms.productsTotal,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      retryAt: Math.max(
        challenge.lastSentAt + 60000,
        locked ? budget!.windowStartedAt + 600000 : 0,
      ),
      delivered: counts
        .filter((row) => row.status === 'delivered')
        .reduce((sum, row) => sum + row.total, 0),
      pending: counts
        .filter((row) => ['pending', 'processing'].includes(row.status))
        .reduce((sum, row) => sum + row.total, 0),
    };
  }
  return {
    permittedRoles: policy.permittedRoles,
    describe,
    async request(user, state) {
      const { terms, required, selection } = requirement(user, state);
      if (!required) return emptyView(terms, 'not-required');
      await db.get('writer').transaction(async (tx) => {
        await lockSession(tx, state);
        const [row] = await tx
            .select()
            .from(discountChallenges)
            .where(eq(discountChallenges.checkoutId, state.id))
            .for('update'),
          existing = row?.state;
        if (
          existing &&
          existing.binding === terms.binding &&
          existing.expiresAt > now() &&
          existing.attempts < 5
        )
          return;
        const budget = await operatorLimit(tx, state.operatorId);
        if (budget.attempts >= 5)
          throw new AppError(
            429,
            'DISCOUNT_APPROVAL_ATTEMPT_LIMIT',
            'Wait before requesting another manager approval.',
          );
        if (budget.lastSentAt + 60000 > now())
          throw new AppError(
            429,
            'DISCOUNT_APPROVAL_SEND_LIMIT',
            'Wait before requesting another manager code.',
          );
        if (existing && existing.lastSentAt + 60000 > now())
          throw new AppError(
            429,
            'DISCOUNT_APPROVAL_SEND_LIMIT',
            'Wait before requesting another manager code.',
          );
        options.assertDeliveryReady();
        if (!options.approvalSecret || options.approvalSecret.length < 32)
          throw new AppError(
            503,
            'DISCOUNT_APPROVAL_UNAVAILABLE',
            'Manager discount approval is not configured.',
          );
        const recipients = await managers(tx, selection);
        if (!recipients.length)
          throw new AppError(
            503,
            'DISCOUNT_APPROVER_UNAVAILABLE',
            'No active manager has an approval delivery contact.',
          );
        const challenge: DiscountChallenge = {
            id: crypto.randomUUID(),
            binding: terms.binding,
            amount: terms.amount,
            productsTotal: terms.productsTotal,
            expiresAt: now() + policy.expirySeconds * 1000,
            lastSentAt: now(),
            attempts: 0,
            codes: [],
            approvedBy: null,
            approvedAt: null,
          },
          used = new Set<string>(),
          trace = currentRequestTrace();
        const deliveries = recipients.map((managerId) => {
          let code = approvalCode();
          while (used.has(code)) code = approvalCode();
          used.add(code);
          challenge.codes.push({
            managerId,
            digest: codeDigest(options.approvalSecret!, challenge.id, managerId, code),
          });
          const id = crypto.randomUUID();
          return {
            id,
            checkoutId: state.id,
            challengeId: challenge.id,
            targetId: managerId,
            kind: 'approval-code',
            status: 'pending',
            encryptedCode: encryptCode(options.approvalSecret!, id, code),
            operatorId: state.operatorId,
            requestId: trace?.requestId || null,
            createdAt: date(),
          };
        });
        await tx
          .insert(discountChallenges)
          .values({ checkoutId: state.id, state: challenge, updatedAt: date() })
          .onDuplicateKeyUpdate({ set: { state: challenge, updatedAt: date() } });
        await tx.insert(discountDeliveries).values(deliveries);
        await tx
          .update(discountApprovalLimits)
          .set({ lastSentAt: now() })
          .where(eq(discountApprovalLimits.operatorId, state.operatorId));
      });
      return describe(user, state);
    },
    async confirm(user, state, code) {
      const { terms, required, selection } = requirement(user, state);
      if (!required) return emptyView(terms, 'not-required');
      const error = await db.get('writer').transaction(async (tx) => {
        await lockSession(tx, state);
        const [row] = await tx
            .select()
            .from(discountChallenges)
            .where(eq(discountChallenges.checkoutId, state.id))
            .for('update'),
          challenge = row?.state;
        if (!challenge || challenge.binding !== terms.binding || challenge.expiresAt <= now())
          return 'DISCOUNT_APPROVAL_CHALLENGE_REQUIRED';
        if (challenge.approvedBy) return null;
        if (challenge.attempts >= 5) return 'DISCOUNT_APPROVAL_ATTEMPT_LIMIT';
        const budget = await operatorLimit(tx, state.operatorId);
        if (budget.attempts >= 5) return 'DISCOUNT_APPROVAL_ATTEMPT_LIMIT';
        if (!options.approvalSecret)
          throw new AppError(
            503,
            'DISCOUNT_APPROVAL_UNAVAILABLE',
            'Manager discount approval is not configured.',
          );
        let matched: string | null = null;
        for (const entry of challenge.codes)
          if (
            matchesCode(options.approvalSecret, challenge.id, entry.managerId, code, entry.digest)
          )
            matched = entry.managerId;
        if (matched && !(await managers(tx, selection)).includes(matched)) matched = null;
        const next: DiscountChallenge = {
          ...challenge,
          attempts: challenge.attempts + 1,
          approvedBy: matched,
          approvedAt: matched ? now() : null,
          codes: matched ? [] : challenge.codes,
        };
        await tx
          .update(discountChallenges)
          .set({ state: next, updatedAt: date() })
          .where(eq(discountChallenges.checkoutId, state.id));
        await tx
          .update(discountApprovalLimits)
          .set({ attempts: budget.attempts + 1 })
          .where(eq(discountApprovalLimits.operatorId, state.operatorId));
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
    async authorize(user, state) {
      const { terms, required, selection } = requirement(user, state);
      if (!required) return { terms, approvalId: null, approvedBy: null };
      return db.get('writer').transaction(async (tx) => {
        await lockSession(tx, state);
        const [row] = await tx
            .select()
            .from(discountChallenges)
            .where(eq(discountChallenges.checkoutId, state.id))
            .for('update'),
          challenge = row?.state;
        if (
          !challenge ||
          challenge.binding !== terms.binding ||
          challenge.expiresAt <= now() ||
          !challenge.approvedBy ||
          !(await managers(tx, selection)).includes(challenge.approvedBy)
        )
          throw new AppError(
            403,
            'DISCOUNT_APPROVAL_REQUIRED',
            'A manager must approve the current final quote before this order is created.',
          );
        return { terms, approvalId: challenge.id, approvedBy: challenge.approvedBy };
      });
    },
    async record(state, orderId, evidence: DiscountApprovalEvidence) {
      if (evidence.terms.amount === '0.00') return;
      await db.get('writer').transaction(async (tx) => {
        await lockSession(tx, state);
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
        const [existing] = await tx
          .select()
          .from(discountAudits)
          .where(eq(discountAudits.orderId, orderId))
          .for('update');
        if (existing) {
          if (
            existing.checkoutId !== state.id ||
            existing.amount !== evidence.terms.amount ||
            existing.approvalId !== evidence.approvalId
          )
            throw new AppError(
              409,
              'DISCOUNT_AUDIT_CONFLICT',
              'This order already has a different discount audit.',
            );
          return;
        }
        const users = await tx
          .select({ id: PosUser.id, name: PosUser.first_name })
          .from(PosUser)
          .where(
            inArray(PosUser.id, [
              BigInt(state.operatorId),
              ...(evidence.approvedBy ? [BigInt(evidence.approvedBy)] : []),
            ]),
          );
        const name = (id: string) =>
          Array.from(users.find((row) => String(row.id) === id)?.name || '')
            .slice(0, 45)
            .join('');
        await tx.insert(discountAudits).values({
          orderId,
          checkoutId: state.id,
          approvalId: evidence.approvalId,
          approvedBy: evidence.approvedBy,
          appliedBy: state.operatorId,
          amount: evidence.terms.amount,
          comment: evidence.terms.comment,
          createdAt: date(),
        });
        await tx.insert(legacyDiscountAddons).values({
          orderId,
          description: evidence.terms.comment,
          amount: new Decimal(evidence.terms.amount).trunc().toNumber(),
          otp: null,
          providedBy: evidence.approvedBy ? legacyInt(evidence.approvedBy) : null,
          providedByName: evidence.approvedBy ? name(evidence.approvedBy) : null,
          appliedBy: legacyInt(state.operatorId),
          appliedByName: name(state.operatorId),
          storeId: legacyInt(state.storeId),
          counterId: legacyInt(state.counterId),
        });
        await tx
          .update(Order)
          .set({
            store_disc_pg_comment: evidence.terms.storeComment,
            store_disc_pg_reason: evidence.terms.storeReason,
          })
          .where(eq(Order.id, BigInt(orderId)));
        await tx.insert(discountDeliveries).values({
          id: 'discount-used:' + orderId,
          checkoutId: state.id,
          challengeId: evidence.approvalId,
          orderId,
          targetId: evidence.approvedBy || state.operatorId,
          kind: 'discount-used',
          status: 'pending',
          encryptedCode: null,
          operatorId: state.operatorId,
          requestId: currentRequestTrace()?.requestId || null,
          createdAt: date(),
        });
      });
    },
  };
}
