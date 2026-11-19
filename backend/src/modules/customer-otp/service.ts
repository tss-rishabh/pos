import { createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  customerContactBindingSchema,
  sameCustomerContact,
  type CustomerContactBinding,
} from '../checkout/customer-contact-authority.js';
import { wireId } from '../checkout/payloads.js';
import { checkoutSessionStore, type CheckoutSessionStore } from '../checkout/session-store.js';
import {
  configuredStateStore,
  readJson,
  withStateLock,
  type PosStateStore,
} from '../checkout/state-store.js';
import { customerOtpApiV2 } from './api-v2.js';
import {
  assertCustomerOtpActor,
  customerOtpAuthority,
  customerOtpChanged,
  type CustomerOtpAuthority,
} from './authority.js';
import {
  customerOtpErrorSchema,
  customerOtpOperationViewSchema,
  customerOtpScopeSchema,
  customerOtpViewSchema,
  type CustomerOtpApi,
  type CustomerOtpApiReply,
  type CustomerOtpScope,
  type CustomerOtpView,
} from './contracts.js';
import type { CustomerOtpOptions } from './options.js';

/** Challenge lifetime. API-v2 stores its code without expiry; the POS bounds every challenge. */
export const CUSTOMER_OTP_CHALLENGE_MS = 5 * 60_000;
/** A send with no recorded answer after this long is reported as `uncertain`, not `pending`. */
const PENDING_GRACE_MS = 15_000;
/** Operation receipts outlive the challenge by an hour for lost-response recovery. */
const RECEIPT_GRACE_SECONDS = 3600;
/** Legacy `AjaxVerifyOtpView` success message (`order/views.py:2577`). */
export const API_V2_OTP_VERIFIED = 'OTP verified successfully!';

const challengeSchema = z
  .object({
    scope: customerOtpScopeSchema,
    contact: customerContactBindingSchema,
    state: z.enum(['PENDING', 'SENT', 'UNCERTAIN', 'REJECTED', 'VERIFIED', 'LOCKED']),
    attempts: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    verifiedUntil: z.number().int().nonnegative().nullable(),
    operations: z.record(
      z.uuid(),
      z
        .object({
          kind: z.enum(['request', 'verify']),
          requestHash: z.string().regex(/^[a-f0-9]{64}$/),
          error: customerOtpErrorSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
type Challenge = z.infer<typeof challengeSchema>;
type OtpError = z.infer<typeof customerOtpErrorSchema>;

/**
 * Redis keys (ephemeral, all with TTL):
 * - `pos:customer_otp:{challengeId}`: Challenge JSON (scope ids, contact binding digest, state,
 *   attempts, expiry, verified-until, operation receipts). No code, phone or email.
 *   TTL = max(expiresAt, verifiedUntil) - now + 1 h.
 * - `pos:customer_otp_lock:{challengeId}`: lock token, 30 s.
 * - `pos:customer_otp_budget:customer:{customerId}:{businessDay}`: send counter, 2 days.
 */
export const customerOtpKeys = {
  challenge: (id: string) => `pos:customer_otp:${id}`,
  lock: (id: string) => `pos:customer_otp_lock:${id}`,
  budget: (customerId: string, day: string) =>
    `pos:customer_otp_budget:customer:${customerId}:${day}`,
};

const missing = () =>
  new AppError(404, 'CUSTOMER_OTP_NOT_FOUND', 'Customer verification was not found.');
const conflict = () =>
  new AppError(
    409,
    'IDEMPOTENCY_CONFLICT',
    'This request key was used for different verification details.',
  );
const busy = () =>
  new AppError(409, 'CUSTOMER_OTP_BUSY', 'This customer verification is still being processed.');
export const customerOtpErrors: Record<OtpError, () => AppError> = {
  CUSTOMER_OTP_INVALID: () =>
    new AppError(400, 'CUSTOMER_OTP_INVALID', 'Wrong OTP! Please enter correct OTP.'),
  CUSTOMER_OTP_ATTEMPT_LIMIT: () =>
    new AppError(
      429,
      'CUSTOMER_OTP_ATTEMPT_LIMIT',
      'Too many wrong codes. Request a new customer verification code.',
    ),
  CUSTOMER_OTP_NOT_SENT: () =>
    new AppError(
      400,
      'CUSTOMER_OTP_NOT_SENT',
      'OTP Not Sent. The customer has no reachable mobile or email.',
    ),
};

/** Legacy `AjaxSendOtpView.post` (`order/views.py:2541-2545`): sent when mobile or email is true. */
export function interpretSendReply(reply: CustomerOtpApiReply): 'sent' | 'rejected' | 'uncertain' {
  if (!reply || reply.status >= 500) return 'uncertain';
  if (reply.status !== 200) return 'rejected';
  const body = z
    .object({ mobile: z.unknown().optional(), email: z.unknown().optional() })
    .passthrough()
    .safeParse(reply.body);
  if (!body.success) return 'uncertain';
  return body.data.mobile === true || body.data.email === true ? 'sent' : 'rejected';
}
/**
 * Legacy `AjaxVerifyOtpView.post` (`order/views.py:2569-2580`): any non-200 is "Wrong OTP"; a 200
 * whose message is "OTP verified successfully!" verifies. A 5xx or missing answer is reported as
 * unavailable without spending an attempt.
 */
export function interpretVerifyReply(
  reply: CustomerOtpApiReply,
): 'verified' | 'wrong' | 'unavailable' {
  if (!reply || reply.status >= 500) return 'unavailable';
  if (reply.status !== 200) return 'wrong';
  const body = z.object({ message: z.unknown() }).passthrough().safeParse(reply.body);
  return body.success && body.data.message === API_V2_OTP_VERIFIED ? 'verified' : 'wrong';
}

export interface CustomerOtpDependencies {
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  api?: CustomerOtpApi;
  clock?: () => number;
}

/**
 * Customer verification for checkout benefits and order returns. API-v2 generates, delivers and
 * checks the code synchronously, as legacy. The POS keeps only the challenge scope, a bounded
 * expiry, the attempt count and the verified-until proof in Redis.
 */
export function customerOtpService(
  config: Config,
  db: Databases,
  options: CustomerOtpOptions,
  dependencies: CustomerOtpDependencies = {},
) {
  const store = dependencies.stateStore ?? configuredStateStore(config),
    sessions = dependencies.sessions ?? checkoutSessionStore(store),
    api = dependencies.api ?? customerOtpApiV2(config),
    clock = dependencies.clock ?? Date.now,
    authorizeIn = customerOtpAuthority(config, db, sessions, store);
  const digest = (purpose: string, value: unknown) =>
    createHmac('sha256', config.SESSION_SECRET)
      .update('pos.customer-otp.v2:' + purpose + ':')
      .update(JSON.stringify(value))
      .digest('hex');
  function parseScope(user: Principal, raw: CustomerOtpScope) {
    const scope = customerOtpScopeSchema.parse(raw);
    assertCustomerOtpActor(user, scope);
    return scope;
  }
  function authorize(
    scope: CustomerOtpScope,
    challengeId: string,
    operationId?: string,
    allowFrozenConsent = false,
  ) {
    return db
      .get('writer')
      .transaction((tx) => authorizeIn(tx, scope, challengeId, operationId, allowFrozenConsent));
  }
  const read = (id: string) => readJson(store, customerOtpKeys.challenge(id), challengeSchema);
  async function save(id: string, challenge: Challenge) {
    const parsed = challengeSchema.parse(challenge),
      until = Math.max(parsed.expiresAt, parsed.verifiedUntil ?? 0);
    await store.set(
      customerOtpKeys.challenge(id),
      JSON.stringify(parsed),
      Math.max(1, Math.ceil((until - clock()) / 1000)) + RECEIPT_GRACE_SECONDS,
    );
  }
  const locked = <T>(id: string, run: () => Promise<T>) =>
    withStateLock(store, customerOtpKeys.lock(id), run, { ttlSeconds: 30, busy });
  function sameScope(left: CustomerOtpScope, right: CustomerOtpScope) {
    return JSON.stringify(customerOtpScopeSchema.parse(left)) === JSON.stringify(right);
  }
  /** The stored challenge, bound to this scope, contact and (if frozen) order consent. */
  function own(
    challenge: Challenge | null,
    scope: CustomerOtpScope,
    current: CustomerOtpAuthority,
  ): Challenge {
    if (!challenge || !sameScope(challenge.scope, scope)) throw missing();
    if (!sameCustomerContact(challenge.contact, current.contact)) throw customerOtpChanged();
    if (
      current.frozenConsentUntil !== null &&
      (challenge.state !== 'VERIFIED' || challenge.verifiedUntil !== current.frozenConsentUntil)
    )
      throw customerOtpChanged();
    return challenge;
  }
  function view(id: string, challenge: Challenge, now: number): CustomerOtpView {
    const live = challenge.expiresAt > now,
      verifiedUntil =
        challenge.state === 'VERIFIED' && challenge.verifiedUntil && challenge.verifiedUntil > now
          ? challenge.verifiedUntil
          : null;
    const status: CustomerOtpView['status'] = verifiedUntil
      ? 'sent'
      : !live
        ? 'rejected'
        : challenge.state === 'SENT'
          ? 'sent'
          : challenge.state === 'UNCERTAIN'
            ? 'uncertain'
            : challenge.state === 'PENDING'
              ? challenge.createdAt + PENDING_GRACE_MS > now
                ? 'pending'
                : 'uncertain'
              : 'rejected';
    return customerOtpViewSchema.parse({
      id,
      status,
      expiresAt: challenge.expiresAt,
      verifiedUntil,
      contact: challenge.contact,
    });
  }
  function businessDay(now: number) {
    return Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDate()
      .toString();
  }
  return {
    /** Legacy `AjaxSendOtpView` (`order/views.py:2536-2560`). */
    async request(
      user: Principal,
      rawScope: CustomerOtpScope,
      challengeId: string,
      operationId: string,
      expectedContact: CustomerContactBinding,
    ): Promise<CustomerOtpView> {
      api.assertReady();
      const scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      z.uuid().parse(operationId);
      const expected = customerContactBindingSchema.parse(expectedContact);
      const current = await authorize(scope, challengeId, operationId);
      if (!sameCustomerContact(expected, current.contact)) throw customerOtpChanged();
      const hash = digest('request', [scope, challengeId, expected]);
      return locked(challengeId, async () => {
        const existing = await read(challengeId);
        if (existing) {
          const previous = existing.operations[operationId];
          if (
            !previous ||
            previous.kind !== 'request' ||
            previous.requestHash !== hash ||
            !sameScope(existing.scope, scope)
          )
            throw conflict();
          own(existing, scope, current);
          if (previous.error) throw customerOtpErrors[previous.error]();
          return view(challengeId, existing, clock());
        }
        const now = clock(),
          sends = await store.increment(
            customerOtpKeys.budget(scope.customerId, businessDay(now)),
            2 * 86400,
          );
        if (sends > options.CUSTOMER_OTP_SENDS_PER_DAY)
          throw new AppError(
            429,
            'CUSTOMER_OTP_SEND_LIMIT',
            'Too many verification codes were requested for this customer today.',
          );
        const challenge: Challenge = {
          scope,
          contact: current.contact,
          state: 'PENDING',
          attempts: 0,
          createdAt: now,
          expiresAt: now + CUSTOMER_OTP_CHALLENGE_MS,
          verifiedUntil: null,
          operations: { [operationId]: { kind: 'request', requestHash: hash, error: null } },
        };
        await save(challengeId, challenge);
        const outcome = interpretSendReply(await api.sendOtp(wireId(scope.customerId)));
        const next: Challenge = {
          ...challenge,
          state: outcome === 'sent' ? 'SENT' : outcome === 'uncertain' ? 'UNCERTAIN' : 'REJECTED',
          operations: {
            [operationId]: {
              kind: 'request',
              requestHash: hash,
              error: outcome === 'rejected' ? 'CUSTOMER_OTP_NOT_SENT' : null,
            },
          },
        };
        await save(challengeId, next);
        if (outcome === 'rejected') throw customerOtpErrors.CUSTOMER_OTP_NOT_SENT();
        return view(challengeId, next, clock());
      });
    },
    async read(user: Principal, rawScope: CustomerOtpScope, challengeId: string) {
      const scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      const current = await authorize(scope, challengeId, undefined, true);
      return view(challengeId, own(await read(challengeId), scope, current), clock());
    },
    async readOperation(
      user: Principal,
      rawScope: CustomerOtpScope,
      challengeId: string,
      operationId: string,
    ) {
      const scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      z.uuid().parse(operationId);
      const current = await authorize(scope, challengeId, undefined, true);
      let challenge: Challenge;
      try {
        challenge = own(await read(challengeId), scope, current);
      } catch (error) {
        if (error instanceof AppError && error.status === 404) return null;
        throw error;
      }
      const receipt = challenge.operations[operationId];
      if (!receipt) return null;
      return customerOtpOperationViewSchema.parse({
        kind: receipt.kind,
        result: view(challengeId, challenge, clock()),
        error: receipt.error,
      });
    },
    /** Checks an unspent proof inside the caller's writer transaction. Never sends or guesses. */
    async assertVerified(
      tx: AdministrationTransaction,
      user: Principal,
      rawScope: CustomerOtpScope,
      challengeId: string,
      expectedContact: CustomerContactBinding,
      verifiedUntil: number,
    ): Promise<void> {
      const scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      z.number().int().positive().parse(verifiedUntil);
      const expected = customerContactBindingSchema.parse(expectedContact);
      const current = await authorizeIn(tx, scope, challengeId, undefined, true),
        challenge = own(await read(challengeId), scope, current);
      if (
        challenge.state !== 'VERIFIED' ||
        challenge.verifiedUntil !== verifiedUntil ||
        verifiedUntil <= clock() ||
        !sameCustomerContact(expected, current.contact)
      )
        throw new AppError(
          403,
          'CUSTOMER_VERIFICATION_REQUIRED',
          'Verify this customer before using this proof.',
        );
    },
    /** Legacy `AjaxVerifyOtpView` (`order/views.py:2563-2597`); `otp` is the 4-digit code. */
    async verify(
      user: Principal,
      rawScope: CustomerOtpScope,
      challengeId: string,
      operationId: string,
      code: string,
    ): Promise<CustomerOtpView> {
      api.assertReady();
      const scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      z.uuid().parse(operationId);
      if (!/^\d{4}$/.test(code))
        throw new AppError(400, 'CUSTOMER_OTP_FORMAT', 'Please Provide a Valid PIN');
      const current = await authorize(scope, challengeId, operationId);
      const hash = digest('verify', [scope, challengeId, code]);
      const outcome = await locked(challengeId, async () => {
        const challenge = own(await read(challengeId), scope, current),
          previous = challenge.operations[operationId];
        if (previous) {
          if (previous.kind !== 'verify' || previous.requestHash !== hash) throw conflict();
          return { challenge, error: previous.error };
        }
        const now = clock(),
          record = async (next: Challenge, error: OtpError | null) => {
            const saved = {
              ...next,
              operations: {
                ...next.operations,
                [operationId]: { kind: 'verify' as const, requestHash: hash, error },
              },
            };
            await save(challengeId, saved);
            return { challenge: saved, error };
          };
        if (
          challenge.state === 'VERIFIED' &&
          challenge.verifiedUntil &&
          challenge.verifiedUntil > now
        )
          return record(challenge, null);
        if (!['SENT', 'UNCERTAIN'].includes(challenge.state) || challenge.expiresAt <= now)
          throw new AppError(
            403,
            'CUSTOMER_OTP_EXPIRED',
            'Request a new customer verification code.',
          );
        if (challenge.attempts >= options.CUSTOMER_OTP_FAILURES_PER_WINDOW)
          return record({ ...challenge, state: 'LOCKED' }, 'CUSTOMER_OTP_ATTEMPT_LIMIT');
        const result = interpretVerifyReply(
          await api.verifyOtp(wireId(scope.customerId), Number(code)),
        );
        if (result === 'unavailable')
          throw new AppError(
            503,
            'CUSTOMER_OTP_VERIFY_UNAVAILABLE',
            'Customer verification did not answer. Try the code again.',
          );
        if (result === 'verified')
          return record(
            {
              ...challenge,
              state: 'VERIFIED',
              verifiedUntil: clock() + options.REDIS_VERIFIED_USER_OBJECT_EXPIRY * 1000,
            },
            null,
          );
        const attempts = challenge.attempts + 1,
          exhausted = attempts >= options.CUSTOMER_OTP_FAILURES_PER_WINDOW;
        return record(
          { ...challenge, attempts, ...(exhausted ? { state: 'LOCKED' as const } : {}) },
          exhausted ? 'CUSTOMER_OTP_ATTEMPT_LIMIT' : 'CUSTOMER_OTP_INVALID',
        );
      });
      if (outcome.error) throw customerOtpErrors[outcome.error]();
      return view(challengeId, outcome.challenge, clock());
    },
  };
}
